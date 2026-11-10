/** One message per page: the unit of work the worker consumes from RabbitMQ. */
export interface PageTaskMessage {
  /** Unique per publish attempt of this page task; useful for tracing redeliveries. */
  messageId: string;
  jobId: string;
  /** Normalized absolute URL to fetch. */
  url: string;
  depth: number;
  /** Null for the job's start page. */
  parentPageId: number | null;
  /** Carried through api, broker and worker logs. */
  correlationId: string;
}
