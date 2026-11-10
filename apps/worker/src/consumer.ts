import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import type { Logger } from "pino";
import { CRAWL_EXCHANGE, MAX_ATTEMPTS, RETRY_KEY, type PageTaskMessage } from "@alteva/core";
import { failureOf, isTransient } from "./errors";
import { parsePageTask } from "./messages";
import type { PipelineOutcome } from "./pipeline";

const ATTEMPT_HEADER = "x-attempt";

export interface HandlerDeps {
  channel: ConfirmChannel;
  /** The crawl pipeline. Throws when the failure should be retried or dead-lettered. */
  process: (msg: PageTaskMessage, log: Logger) => Promise<PipelineOutcome>;
  /** Called after a page's transaction committed, so the outbox relay can publish its children now. */
  onCommitted: () => void;
  /** Records the page as failed and processed; used when giving up on a message. */
  failPage: (msg: PageTaskMessage, failure: { httpStatus: number | null; message: string }, log: Logger) => Promise<unknown>;
  log: Logger;
}

/**
 * Per-message handling, kept apart from the consume loop so it can be tested with a fake channel.
 *
 *  - malformed message (bad JSON/schema) → DLQ straight away, nothing recorded
 *  - success (incl. permanent page outcomes: 4xx, non-HTML) → ack. New children need no publishing
 *    here: they were queued in the outbox in the same transaction, and the relay sends them.
 *  - transient failure, attempts left → retry queue with x-attempt+1, ack the original
 *  - transient failure, attempts used up, or an unrecoverable error → mark the page failed
 *    (counted as processed, so the job can still finish), then DLQ
 *
 * "To the DLQ" is a nack without requeue: crawl.page dead-letters into crawl.page.dlq.
 */
export function createMessageHandler(deps: HandlerDeps) {
  const { channel, log } = deps;

  return async function handle(raw: ConsumeMessage): Promise<void> {
    let msg: PageTaskMessage;
    try {
      msg = parsePageTask(raw.content);
    } catch (err) {
      log.error({ err, body: raw.content.toString("utf8").slice(0, 500) }, "malformed message, dead-lettering");
      channel.nack(raw, false, false);
      return;
    }

    const msgLog = log.child({ jobId: msg.jobId, correlationId: msg.correlationId, messageId: msg.messageId });
    let outcome: PipelineOutcome;
    try {
      outcome = await deps.process(msg, msgLog);
    } catch (err) {
      await handleFailure(deps, raw, msg, err, msgLog);
      return;
    }

    if (outcome.kind === "processed") deps.onCommitted();
    channel.ack(raw);
  };
}

async function handleFailure(deps: HandlerDeps, raw: ConsumeMessage, msg: PageTaskMessage, err: unknown, log: Logger) {
  const attempt = currentAttempt(raw);
  const transient = isTransient(err);
  if (transient && attempt < MAX_ATTEMPTS) {
    await scheduleRetry(deps.channel, raw, attempt + 1, err, log);
    return;
  }

  log.error({ err, attempt, transient }, transient ? "retries exhausted, dead-lettering" : "unrecoverable error, dead-lettering");
  try {
    await deps.failPage(msg, failureOf(err), log);
  } catch (markErr) {
    // E.g. the database is still down. The page stays `queued`; replaying the DLQ message
    // later recovers it, and replaying one already marked failed is a harmless duplicate.
    log.error({ err: markErr }, "could not mark page failed, it stays queued");
  }
  deps.channel.nack(raw, false, false);
}

/** First delivery has no header, so it counts as attempt 1. */
function currentAttempt(raw: ConsumeMessage): number {
  const header = Number(raw.properties.headers?.[ATTEMPT_HEADER]);
  return Number.isInteger(header) && header >= 1 ? header : 1;
}

async function scheduleRetry(channel: ConfirmChannel, raw: ConsumeMessage, nextAttempt: number, err: unknown, log: Logger) {
  log.warn({ err, nextAttempt, maxAttempts: MAX_ATTEMPTS }, "transient failure, scheduling retry");
  try {
    channel.publish(CRAWL_EXCHANGE, RETRY_KEY, raw.content, {
      persistent: true,
      contentType: "application/json",
      messageId: raw.properties.messageId,
      correlationId: raw.properties.correlationId,
      headers: { ...raw.properties.headers, [ATTEMPT_HEADER]: nextAttempt },
    });
    await channel.waitForConfirms();
    channel.ack(raw);
  } catch (publishErr) {
    // Could not park the message: put it back so it is not lost.
    log.error({ err: publishErr }, "could not publish to retry queue, requeueing");
    channel.nack(raw, false, true);
  }
}
