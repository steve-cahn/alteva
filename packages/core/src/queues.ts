/**
 * Broker topology shared by the api (publisher) and worker (consumer).
 *
 * One direct exchange, three queues:
 *
 *   crawl ─ page      ─▶ crawl.page         work queue
 *   crawl ─ page.retry ─▶ crawl.page.retry  holds a failed message for RETRY_DELAY_MS, then
 *                                           dead-letters it back to crawl.page
 *   crawl ─ page.dlq  ─▶ crawl.page.dlq     poison and exhausted messages; also the dead-letter
 *                                           target of crawl.page (nack without requeue)
 */
export const CRAWL_EXCHANGE = "crawl";

export const PAGE_QUEUE = "crawl.page";
export const PAGE_KEY = "page";

export const RETRY_QUEUE = "crawl.page.retry";
export const RETRY_KEY = "page.retry";
export const RETRY_DELAY_MS = 10_000;

export const PAGE_DLQ = "crawl.page.dlq";
export const DLQ_KEY = "page.dlq";

/** Total processing attempts per message (first delivery included) before it is dead-lettered. */
export const MAX_ATTEMPTS = 3;
