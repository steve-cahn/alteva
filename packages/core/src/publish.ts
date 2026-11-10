import { CRAWL_EXCHANGE, PAGE_KEY } from "./queues";
import type { PageTaskMessage } from "./messages";

/** The slice of an amqplib confirm channel needed to publish. Keeps core free of amqplib. */
export interface PublishChannel {
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: { persistent: boolean; contentType: string; messageId: string; correlationId: string },
    callback: (err: unknown) => void,
  ): boolean;
}

/** Publishes a page task to the work queue; resolves once the broker confirms it, rejects if it cannot. */
export function publishPageTask(channel: PublishChannel, task: PageTaskMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    channel.publish(
      CRAWL_EXCHANGE,
      PAGE_KEY,
      Buffer.from(JSON.stringify(task)),
      { persistent: true, contentType: "application/json", messageId: task.messageId, correlationId: task.correlationId },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}
