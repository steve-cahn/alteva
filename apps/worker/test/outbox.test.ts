import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";
import { drainOutbox, enqueueTasks, startOutboxRelay, type PageTaskMessage, type Queryable } from "@alteva/core";
import { withTransaction } from "../src/db";
import { createTestDb, eventually, postgresAvailable, type TestDb } from "./helpers";

const dbUp = await postgresAvailable();
const log = pino({ level: "silent" });

const task = (n: number): PageTaskMessage => ({
  messageId: randomUUID(),
  jobId: "00000000-0000-0000-0000-000000000001",
  url: `https://site.test/${n}`,
  depth: 1,
  parentPageId: 1,
  correlationId: "c",
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!dbUp)("transactional outbox (postgres)", () => {
  let db: TestDb;
  beforeAll(async () => (db = await createTestDb()));
  afterAll(async () => db.close());
  beforeEach(async () => void (await db.pool.query("DELETE FROM outbox")));

  const transaction = <T>(fn: (q: Queryable) => Promise<T>) => withTransaction(db.pool, fn);
  const rows = async () => (await db.pool.query("SELECT * FROM outbox ORDER BY id")).rows;
  const enqueue = (tasks: PageTaskMessage[]) => transaction((q) => enqueueTasks(q, tasks));
  /** A publish that records what it was given, and can be made to fail on a given message. */
  const recorder = (failOn?: string) => {
    const sent: PageTaskMessage[] = [];
    return {
      sent,
      publish: async (t: PageTaskMessage) => {
        if (t.url === failOn) throw new Error("broker said no");
        sent.push(t);
      },
    };
  };

  describe("enqueueTasks", () => {
    it("stores each message as unpublished, with its payload intact", async () => {
      const [a, b] = [task(1), task(2)];
      await enqueue([a, b]);
      const stored = await rows();
      expect(stored).toHaveLength(2);
      expect(stored.map((r) => r.payload)).toEqual([a, b]);
      expect(stored.every((r) => r.published_at === null && r.attempts === 0)).toBe(true);
    });

    it("ignores an empty list and a message id it already has", async () => {
      const a = task(1);
      await enqueue([]);
      await enqueue([a]);
      await enqueue([a]);
      expect(await rows()).toHaveLength(1);
    });

    it("commits with the surrounding transaction, or not at all", async () => {
      await expect(
        transaction(async (q) => {
          await enqueueTasks(q, [task(1), task(2)]);
          throw new Error("the state change failed");
        }),
      ).rejects.toThrow("state change failed");
      expect(await rows()).toHaveLength(0);
    });
  });

  describe("drainOutbox", () => {
    it("publishes oldest first and marks the rows published", async () => {
      const tasks = [task(1), task(2), task(3)];
      await enqueue(tasks);
      const r = recorder();

      expect(await drainOutbox({ transaction, publish: r.publish })).toEqual({ claimed: 3, published: 3 });
      expect(r.sent).toEqual(tasks);
      const stored = await rows();
      expect(stored.every((row) => row.published_at !== null && row.attempts === 1)).toBe(true);
    });

    it("does not publish a row twice", async () => {
      await enqueue([task(1)]);
      const r = recorder();
      await drainOutbox({ transaction, publish: r.publish });
      expect(await drainOutbox({ transaction, publish: r.publish })).toEqual({ claimed: 0, published: 0 });
      expect(r.sent).toHaveLength(1);
    });

    it("respects the batch size", async () => {
      await enqueue([task(1), task(2), task(3)]);
      const r = recorder();
      expect((await drainOutbox({ transaction, publish: r.publish }, 2)).published).toBe(2);
      expect((await drainOutbox({ transaction, publish: r.publish }, 2)).published).toBe(1);
    });

    it("on a failure keeps what was already published, records the error, and leaves the rest for later", async () => {
      const tasks = [task(1), task(2), task(3)];
      await enqueue(tasks);
      const r = recorder(tasks[1].url);

      const result = await drainOutbox({ transaction, publish: r.publish });
      expect(result).toMatchObject({ claimed: 3, published: 1 });
      expect((result.error as Error).message).toBe("broker said no");

      const [first, second, third] = await rows();
      expect(first.published_at).not.toBeNull();
      expect(second).toMatchObject({ published_at: null, attempts: 1, last_error: "broker said no" });
      expect(third).toMatchObject({ published_at: null, attempts: 0 });

      // The broker recovers: the rest go out, and the first is not sent again.
      const later = recorder();
      expect((await drainOutbox({ transaction, publish: later.publish })).published).toBe(2);
      expect(later.sent).toEqual([tasks[1], tasks[2]]);
    });

    it("lets concurrent relays share the work without publishing any row twice", async () => {
      const tasks = Array.from({ length: 40 }, (_, i) => task(i));
      await enqueue(tasks);
      const r = recorder();
      const slowPublish = async (t: PageTaskMessage) => {
        await wait(2);
        await r.publish(t);
      };

      await Promise.all([1, 2, 3, 4].map(() => drainOutbox({ transaction, publish: slowPublish }, 5)));
      let left = (await rows()).filter((row) => row.published_at === null).length;
      while (left > 0) {
        await drainOutbox({ transaction, publish: slowPublish }, 50);
        left = (await rows()).filter((row) => row.published_at === null).length;
      }

      expect(r.sent).toHaveLength(40);
      expect(new Set(r.sent.map((t) => t.messageId)).size).toBe(40);
    });
  });

  describe("startOutboxRelay", () => {
    it("publishes on its poll without being woken", async () => {
      const r = recorder();
      const relay = startOutboxRelay({ transaction, publish: r.publish, log, pollIntervalMs: 20 });
      await enqueue([task(1)]);
      await eventually(() => r.sent.length === 1);
      await relay.stop();
      expect(r.sent).toHaveLength(1);
    });

    it("publishes straight away when woken, even with a long poll interval", async () => {
      const r = recorder();
      const relay = startOutboxRelay({ transaction, publish: r.publish, log, pollIntervalMs: 60_000 });
      await wait(50); // first (empty) pass done; now it sleeps for a minute
      await enqueue([task(1), task(2)]);
      relay.wake();
      await eventually(() => r.sent.length === 2); // far sooner than the 60 s poll: it was woken
      await relay.stop();
      expect(r.sent).toHaveLength(2);
    });

    it("retries after the broker comes back, without losing anything", async () => {
      const a = task(1);
      let up = false;
      const sent: PageTaskMessage[] = [];
      const relay = startOutboxRelay({
        transaction,
        publish: async (t) => {
          if (!up) throw new Error("broker down");
          sent.push(t);
        },
        log,
        pollIntervalMs: 10,
      });
      await enqueue([a]);
      await eventually(async () => (await rows())[0].attempts > 0); // it has tried, and failed
      expect(sent).toHaveLength(0);
      expect((await rows())[0]).toMatchObject({ published_at: null });

      up = true;
      relay.wake();
      await eventually(() => sent.length === 1); // backoff after failures is short, so the next try is soon
      await relay.stop();
      expect(sent).toEqual([a]);
    }, 10_000);

    it("stops promptly, even mid-sleep", async () => {
      const relay = startOutboxRelay({ transaction, publish: async () => {}, log, pollIntervalMs: 60_000 });
      await wait(30);
      const started = Date.now();
      await relay.stop();
      expect(Date.now() - started).toBeLessThan(2_000); // not the 60 s poll interval
    });

    it("deletes published rows past the retention period and keeps recent and unpublished ones", async () => {
      await enqueue([task(1), task(2), task(3)]);
      await db.pool.query(`UPDATE outbox SET published_at = now() - interval '3 hours' WHERE id = (SELECT min(id) FROM outbox)`);
      await db.pool.query(`UPDATE outbox SET published_at = now() - interval '5 minutes' WHERE id = (SELECT min(id) + 1 FROM outbox)`);

      // The third row is unpublished, so the relay publishes it too; what matters is the old one going.
      const relay = startOutboxRelay({
        transaction,
        publish: async () => {},
        log,
        pollIntervalMs: 20,
        retentionHours: 1,
        cleanupIntervalMs: 10,
      });
      await eventually(async () => (await rows()).length === 2);
      await relay.stop();

      const left = await rows();
      expect(left).toHaveLength(2); // the 3-hour-old row is gone; 5 minutes old and the new one stay
      expect(left.every((r) => r.published_at !== null)).toBe(true);
    });
  });
});
