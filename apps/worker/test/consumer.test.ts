import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { CRAWL_EXCHANGE, MAX_ATTEMPTS, RETRY_KEY, type PageTaskMessage } from "@alteva/core";
import { createMessageHandler } from "../src/consumer";
import { TransientError } from "../src/errors";
import type { PipelineOutcome } from "../src/pipeline";

const log = pino({ level: "silent" });
const task: PageTaskMessage = { messageId: "m1", jobId: "j1", url: "https://s.com/", depth: 0, parentPageId: null, correlationId: "c1" };

function fakeChannel() {
  return {
    ack: vi.fn(),
    nack: vi.fn(),
    publish: vi.fn(() => true),
    waitForConfirms: vi.fn(async () => {}),
  };
}

function rawMessage(content: unknown, headers: Record<string, unknown> = {}): ConsumeMessage {
  const body = typeof content === "string" ? content : JSON.stringify(content);
  return { content: Buffer.from(body), fields: {}, properties: { headers, messageId: "m1", correlationId: "c1" } } as unknown as ConsumeMessage;
}

type Process = (msg: PageTaskMessage) => Promise<PipelineOutcome>;

function setup(process: Process = async () => ({ kind: "duplicate" })) {
  const ch = fakeChannel();
  const failPage = vi.fn(async () => ({ kind: "duplicate" }));
  const onCommitted = vi.fn();
  const handle = createMessageHandler({ channel: ch as unknown as ConfirmChannel, process, failPage, onCommitted, log });
  return { ch, failPage, onCommitted, handle };
}

const failing = (err: unknown): Process => async () => {
  throw err;
};

describe("message handler: malformed messages", () => {
  it.each([
    ["bad JSON", "{not json"],
    ["a schema violation", { ...task, depth: "deep" }],
  ])("sends %s straight to the DLQ, touching nothing else", async (_name, payload) => {
    const process = vi.fn();
    const { ch, failPage, handle } = setup(process);
    const raw = rawMessage(payload);
    await handle(raw);

    expect(ch.nack).toHaveBeenCalledWith(raw, false, false);
    expect(ch.ack).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
    expect(failPage).not.toHaveBeenCalled();
    expect(ch.publish).not.toHaveBeenCalled();
  });
});

describe("message handler: success", () => {
  it("acks, and wakes the outbox relay, without publishing anything itself", async () => {
    const child: PageTaskMessage = { ...task, messageId: "m2", url: "https://s.com/a", depth: 1, parentPageId: 5 };
    const { ch, onCommitted, handle } = setup(async () => ({ kind: "processed", children: [child], jobStatus: "Running" }));
    const raw = rawMessage(task);
    await handle(raw);

    expect(ch.ack).toHaveBeenCalledWith(raw);
    expect(onCommitted).toHaveBeenCalledTimes(1);
    // The children are already in the outbox: the consumer neither publishes nor waits on confirms.
    expect(ch.publish).not.toHaveBeenCalled();
    expect(ch.waitForConfirms).not.toHaveBeenCalled();
  });

  it.each([{ kind: "duplicate" }, { kind: "ignored", reason: "job is Canceled" }] as PipelineOutcome[])(
    "acks a %o outcome without waking the relay: nothing new was queued",
    async (outcome) => {
      const { ch, onCommitted, handle } = setup(async () => outcome);
      const raw = rawMessage(task);
      await handle(raw);
      expect(ch.ack).toHaveBeenCalledWith(raw);
      expect(onCommitted).not.toHaveBeenCalled();
      expect(ch.publish).not.toHaveBeenCalled();
    },
  );
});

describe("message handler: transient failures", () => {
  it("retries via the retry queue with x-attempt 2 after the first failure, and acks the original", async () => {
    const { ch, failPage, handle } = setup(failing(new TransientError("HTTP 503", 503)));
    const raw = rawMessage(task);
    await handle(raw);

    expect(ch.publish).toHaveBeenCalledWith(
      CRAWL_EXCHANGE,
      RETRY_KEY,
      raw.content,
      expect.objectContaining({ persistent: true, headers: { "x-attempt": 2 } }),
    );
    expect(ch.ack).toHaveBeenCalledWith(raw);
    expect(ch.nack).not.toHaveBeenCalled();
    expect(failPage).not.toHaveBeenCalled();
  });

  it("retries once more on the second failure", async () => {
    const { ch, handle } = setup(failing(new TransientError("timeout")));
    await handle(rawMessage(task, { "x-attempt": 2 }));
    expect(ch.publish).toHaveBeenCalledWith(CRAWL_EXCHANGE, RETRY_KEY, expect.anything(), expect.objectContaining({ headers: { "x-attempt": 3 } }));
  });

  it("treats database connection errors as transient", async () => {
    const { ch, handle } = setup(failing(Object.assign(new Error("terminating connection"), { code: "57P01" })));
    await handle(rawMessage(task));
    expect(ch.publish).toHaveBeenCalledWith(CRAWL_EXCHANGE, RETRY_KEY, expect.anything(), expect.anything());
  });

  it(`gives up after ${MAX_ATTEMPTS} attempts: marks the page failed with the last error, then dead-letters`, async () => {
    const { ch, failPage, handle } = setup(failing(new TransientError("HTTP 503", 503)));
    const raw = rawMessage(task, { "x-attempt": MAX_ATTEMPTS });
    await handle(raw);

    expect(failPage).toHaveBeenCalledWith(task, { httpStatus: 503, message: "HTTP 503" }, expect.anything());
    expect(ch.nack).toHaveBeenCalledWith(raw, false, false);
    expect(ch.publish).not.toHaveBeenCalled();
    expect(ch.ack).not.toHaveBeenCalled();
  });

  it("still dead-letters when marking the page failed also fails (e.g. database down)", async () => {
    const { ch, failPage, handle } = setup(failing(new TransientError("timeout")));
    failPage.mockRejectedValue(new Error("Connection terminated unexpectedly"));
    const raw = rawMessage(task, { "x-attempt": MAX_ATTEMPTS });
    await handle(raw);
    expect(ch.nack).toHaveBeenCalledWith(raw, false, false);
  });

  it("requeues the original when the retry publish itself fails, so it is not lost", async () => {
    const { ch, handle } = setup(failing(new TransientError("timeout")));
    ch.waitForConfirms.mockRejectedValue(new Error("channel closed"));
    const raw = rawMessage(task);
    await handle(raw);

    expect(ch.nack).toHaveBeenCalledWith(raw, false, true);
    expect(ch.ack).not.toHaveBeenCalled();
  });

  it("treats a missing or garbage x-attempt header as the first attempt", async () => {
    for (const headers of [{}, { "x-attempt": "abc" }, { "x-attempt": 0 }]) {
      const { ch, handle } = setup(failing(new TransientError("timeout")));
      await handle(rawMessage(task, headers));
      expect(ch.publish).toHaveBeenCalledWith(CRAWL_EXCHANGE, RETRY_KEY, expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ "x-attempt": 2 }) }));
    }
  });
});

describe("message handler: unrecoverable errors", () => {
  it("does not retry a permanent database error: marks the page failed and dead-letters at once", async () => {
    const { ch, failPage, handle } = setup(failing(Object.assign(new Error("invalid input syntax for type uuid"), { code: "22P02" })));
    const raw = rawMessage(task);
    await handle(raw);

    expect(failPage).toHaveBeenCalledWith(task, { httpStatus: null, message: "invalid input syntax for type uuid" }, expect.anything());
    expect(ch.nack).toHaveBeenCalledWith(raw, false, false);
    expect(ch.publish).not.toHaveBeenCalled();
  });
});
