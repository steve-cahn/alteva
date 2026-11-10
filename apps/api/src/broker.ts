import amqp, { type ChannelModel, type ConfirmChannel } from "amqplib";
import type { Logger } from "pino";
import { declareTopology, publishPageTask, type PageTaskMessage } from "@alteva/core";

/** What the routes need to know about the broker: just whether it is reachable. */
export interface BrokerStatus {
  isHealthy(): boolean;
}

/** The broker connection. The outbox relay publishes through `publishPageTask`; routes never do. */
export interface Broker extends BrokerStatus {
  /** Resolves once the broker confirms the message; rejects while there is no connection. */
  publishPageTask(task: PageTaskMessage): Promise<void>;
  close(): Promise<void>;
}

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 15_000;

/**
 * Keeps a confirm channel to RabbitMQ, reconnecting by itself whenever it is lost. It never throws
 * and never blocks startup: the api serves requests with the broker down, because jobs are committed
 * to the outbox and the relay publishes them once this reconnects. Unlike the worker, which cannot
 * do anything without the broker, the api has no reason to exit when it goes away.
 */
export function startBroker(url: string, log: Pick<Logger, "info" | "warn" | "error">): Broker {
  let channel: ConfirmChannel | undefined;
  let connection: ChannelModel | undefined;
  let closing = false;

  async function connectOnce(): Promise<ChannelModel> {
    const conn = await amqp.connect(url);
    const ch = await conn.createConfirmChannel();
    // Declared here as well as in the worker: whichever starts first must not publish into a void.
    await declareTopology(ch);
    connection = conn;
    channel = ch;
    ch.on("error", (err) => log.error({ err }, "broker channel error"));
    conn.on("error", (err) => log.error({ err }, "broker connection error"));
    return conn;
  }

  const loop = (async () => {
    let delay = FIRST_RETRY_MS;
    while (!closing) {
      try {
        const conn = await connectOnce();
        log.info({}, "connected to the message broker");
        delay = FIRST_RETRY_MS;
        await new Promise<void>((resolve) => conn.once("close", () => resolve()));
        channel = undefined;
        if (!closing) log.warn({}, "lost the message broker connection, reconnecting");
      } catch (err) {
        channel = undefined;
        log.warn({ err, retryInMs: delay }, "message broker not reachable");
      }
      if (!closing) await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(MAX_RETRY_MS, delay * 2);
    }
  })();

  return {
    isHealthy: () => channel !== undefined,
    publishPageTask: (task) => (channel ? publishPageTask(channel, task) : Promise.reject(new Error("message broker not connected"))),
    close: async () => {
      closing = true;
      channel = undefined;
      await connection?.close().catch(() => {});
      await loop;
    },
  };
}
