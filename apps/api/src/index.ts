import pino from "pino";
import { ConfigError, startOutboxRelay } from "@alteva/core";
import { buildApp } from "./app";
import { startBroker } from "./broker";
import { loadConfig } from "./config";
import { createPool, withTransaction } from "./db";
import { failStaleJobs } from "./jobs";
import { runMigrations } from "./migrate";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (err) {
  // The logger needs the config, so a bad config is reported plainly, and without echoing any value.
  console.error(JSON.stringify({ level: 60, msg: "invalid configuration", error: err instanceof ConfigError ? err.message : String(err) }));
  process.exit(1);
}

// Startup logger, used before Fastify's own exists.
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
  const pool = createPool(config.databaseUrl, "alteva-api");
  pool.on("error", (err) => log.error({ err }, "idle database client error"));

  const applied = await runMigrations(pool, config.migrationsDir);
  log.info({ applied }, "migrations complete");

  // Does not wait for RabbitMQ: jobs are committed to the outbox, and the relay publishes them
  // once the broker is (back) up.
  const broker = startBroker(config.rabbitmqUrl, log);
  // Jobs are committed together with their root message in the outbox; this publishes it.
  const relay = startOutboxRelay({
    transaction: (fn) => withTransaction(pool, fn),
    publish: (task) => broker.publishPageTask(task),
    log,
  });
  const app = await buildApp({
    pool,
    broker,
    outbox: relay,
    corsOrigins: config.corsOrigins,
    defaultMaxDepth: config.defaultMaxDepth,
    defaultMaxPages: config.defaultMaxPages,
    logger: { level: config.logLevel },
  });
  await app.listen({ port: config.port, host: "0.0.0.0" });

  const reaper = setInterval(() => {
    failStaleJobs(pool, config.jobTimeoutMinutes).then(
      (ids) => ids.length > 0 && app.log.warn({ jobIds: ids }, "failed jobs that exceeded the time limit"),
      (err) => app.log.error({ err }, "stale job check failed"),
    );
  }, config.reaperIntervalMs);
  reaper.unref();

  let shuttingDown = false;
  /** Stop accepting requests, finish the ones in progress, then close everything. */
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    const forced = setTimeout(() => {
      app.log.error({ timeoutMs: config.shutdownTimeoutMs }, "shutdown timed out, exiting anyway");
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forced.unref();
    try {
      clearInterval(reaper);
      await app.close();
      await relay.stop();
      await broker.close();
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

main().catch((err) => {
  log.fatal({ err }, "api failed to start");
  process.exit(1);
});
