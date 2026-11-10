import amqp, { type ChannelModel } from "amqplib";
import pino from "pino";
import { ConfigError, declareTopology, PAGE_QUEUE, publishPageTask, startOutboxRelay } from "@alteva/core";
import { loadConfig } from "./config";
import { createPool, withTransaction } from "./db";
import { createMessageHandler } from "./consumer";
import { fetchPage } from "./fetcher";
import { startHealthServer } from "./health";
import { failPage, processPage } from "./pipeline";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (err) {
  // The logger needs the config, so a bad config is reported plainly, and without echoing any value.
  console.error(JSON.stringify({ level: 60, msg: "invalid configuration", error: err instanceof ConfigError ? err.message : String(err) }));
  process.exit(1);
}

const log = pino({ level: config.logLevel });

// Anything that escapes is a bug. Log it as one, and exit: the container restarts a clean process.
process.on("unhandledRejection", (reason) => {
  log.fatal({ err: reason }, "unhandled promise rejection");
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  log.fatal({ err }, "uncaught exception");
  process.exit(1);
});

async function main() {
  const pool = createPool(config.databaseUrl, "alteva-worker");
  pool.on("error", (err) => log.error({ err }, "idle database client error"));

  const connection = await connectWithRetry(config.rabbitmqUrl);
  const channel = await connection.createConfirmChannel();
  let channelOpen = true;
  let shuttingDown = false;
  channel.on("close", () => (channelOpen = false));
  channel.on("error", (err) => log.error({ err }, "channel error"));
  // Losing the broker connection is unrecoverable here: exit and let the container restart us. But
  // closing it ourselves, as part of a shutdown, is not a loss.
  connection.on("close", () => {
    if (shuttingDown) return;
    log.error("broker connection lost, exiting");
    process.exit(1);
  });
  connection.on("error", (err) => log.error({ err }, "broker connection error"));

  await declareTopology(channel);
  await channel.prefetch(config.prefetch);

  const deps = { pool, fetchPage };
  // Children are queued in the outbox inside each page's transaction; this publishes them.
  const relay = startOutboxRelay({
    transaction: (fn) => withTransaction(pool, fn),
    publish: (task) => publishPageTask(channel, task),
    log,
  });
  const inFlight = new Set<Promise<void>>();
  const handle = createMessageHandler({
    channel,
    log,
    onCommitted: () => relay.wake(),
    process: (msg, msgLog) => processPage(deps, msg, msgLog),
    failPage: (msg, failure, msgLog) => failPage(deps, msg, failure, msgLog),
  });
  const { consumerTag } = await channel.consume(
    PAGE_QUEUE,
    (raw) => {
      if (!raw) return; // consumer cancelled by the broker
      const task = handle(raw).catch((err) => log.error({ err }, "unhandled error in message handler"));
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    },
    { noAck: false },
  );

  const server = await startHealthServer(
    config.port,
    { database: () => pool.query("SELECT 1").then(() => undefined), channelOpen: () => channelOpen },
    log,
  );
  log.info({ port: config.port, queue: PAGE_QUEUE, prefetch: config.prefetch }, "worker started");

  /**
   * Stop taking work, let the pages in progress finish and be acknowledged, publish what they
   * queued, then close everything. A page cut off here is not lost: its message is unacknowledged,
   * so the broker redelivers it, and the worker is idempotent.
   */
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    const forced = setTimeout(() => {
      log.error({ timeoutMs: config.shutdownTimeoutMs }, "shutdown timed out, exiting anyway");
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forced.unref();
    try {
      await channel.cancel(consumerTag);
      await Promise.allSettled(inFlight);
      await relay.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await channel.close().catch(() => {});
      await connection.close().catch(() => {});
      await pool.end();
      log.info("shutdown complete");
      process.exit(0);
    } catch (err) {
      log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

async function connectWithRetry(url: string, attempts = 15, delayMs = 2_000): Promise<ChannelModel> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await amqp.connect(url);
    } catch (err) {
      if (attempt >= attempts) throw err;
      log.warn({ err, attempt }, "RabbitMQ not reachable yet, retrying");
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

main().catch((err) => {
  log.fatal({ err }, "worker failed to start");
  process.exit(1);
});
