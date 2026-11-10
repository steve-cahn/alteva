import {
  CRAWL_EXCHANGE,
  DLQ_KEY,
  PAGE_DLQ,
  PAGE_KEY,
  PAGE_QUEUE,
  RETRY_DELAY_MS,
  RETRY_KEY,
  RETRY_QUEUE,
} from "./queues";

/** The slice of an amqplib channel that declaring the topology needs. Keeps core free of amqplib. */
export interface TopologyChannel {
  assertExchange(exchange: string, type: "direct", options: { durable: boolean }): Promise<unknown>;
  assertQueue(
    queue: string,
    options: { durable: boolean; messageTtl?: number; deadLetterExchange?: string; deadLetterRoutingKey?: string },
  ): Promise<unknown>;
  bindQueue(queue: string, source: string, pattern: string): Promise<unknown>;
}

/**
 * Declares the topology described in `queues.ts`. Idempotent, but RabbitMQ rejects a redeclare
 * with different arguments, so every process declares it through this one function. Both the api
 * (which publishes) and the worker (which consumes) call it on startup, in whichever order.
 */
export async function declareTopology(channel: TopologyChannel): Promise<void> {
  await channel.assertExchange(CRAWL_EXCHANGE, "direct", { durable: true });

  await channel.assertQueue(PAGE_DLQ, { durable: true });
  await channel.bindQueue(PAGE_DLQ, CRAWL_EXCHANGE, DLQ_KEY);

  // A nack without requeue on crawl.page dead-letters to the DLQ.
  await channel.assertQueue(PAGE_QUEUE, {
    durable: true,
    deadLetterExchange: CRAWL_EXCHANGE,
    deadLetterRoutingKey: DLQ_KEY,
  });
  await channel.bindQueue(PAGE_QUEUE, CRAWL_EXCHANGE, PAGE_KEY);

  // Nobody consumes the retry queue: messages sit for the TTL, then return to crawl.page.
  await channel.assertQueue(RETRY_QUEUE, {
    durable: true,
    messageTtl: RETRY_DELAY_MS,
    deadLetterExchange: CRAWL_EXCHANGE,
    deadLetterRoutingKey: PAGE_KEY,
  });
  await channel.bindQueue(RETRY_QUEUE, CRAWL_EXCHANGE, RETRY_KEY);
}
