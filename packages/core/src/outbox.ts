import type { PageTaskMessage } from "./messages";

/**
 * The transactional outbox, as plain orchestration over injected ports. Core imports no database
 * or broker library: the apps pass in what they already have (a transaction helper and a publish
 * function), the same way `declareTopology` takes a channel.
 */

/** The slice of a database client the outbox needs. A `pg` client or pool satisfies it. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Queues messages for publishing. Call it with the client of the transaction that changes the
 * state the messages describe, so both commit together. Re-queuing a known `messageId` is a no-op.
 */
export async function enqueueTasks(db: Queryable, tasks: PageTaskMessage[]): Promise<void> {
  if (tasks.length === 0) return;
  await db.query(
    `INSERT INTO outbox (message_id, payload)
     SELECT (t->>'messageId')::uuid, t FROM jsonb_array_elements($1::jsonb) AS t
     ON CONFLICT (message_id) DO NOTHING`,
    [JSON.stringify(tasks)],
  );
}

export interface RelayLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface RelayDeps {
  /** Runs `fn` in one transaction: commit when it returns, roll back when it throws. */
  transaction<T>(fn: (db: Queryable) => Promise<T>): Promise<T>;
  /** Publishes one message and resolves once the broker has confirmed it. */
  publish(task: PageTaskMessage): Promise<void>;
  log: RelayLog;
  /** How often to look for unpublished messages when nothing wakes the relay. */
  pollIntervalMs?: number;
  batchSize?: number;
  /** Published rows older than this are deleted. */
  retentionHours?: number;
  /** How often old published rows are deleted. */
  cleanupIntervalMs?: number;
}

export interface OutboxRelay {
  /** Publish now instead of waiting for the next poll. Call it after committing new messages. */
  wake(): void;
  /** Stop after the batch in progress. */
  stop(): Promise<void>;
}

export interface DrainResult {
  /** Rows looked at, published or not. */
  claimed: number;
  published: number;
  /** Set when a publish failed; everything before it in the batch was still committed as published. */
  error?: unknown;
}

interface OutboxRow {
  id: string | number;
  payload: PageTaskMessage;
}

/**
 * Publishes one batch of unpublished messages, oldest first. Rows are claimed with
 * `FOR UPDATE SKIP LOCKED`, so any number of relays (the api and every worker run one) can work at
 * the same time without publishing a row twice. If publishing fails part-way, the messages already
 * confirmed are still marked published and the failure is recorded on the row that failed.
 * Delivery is at-least-once (a crash between publish and commit republishes), which the idempotent
 * worker is built for.
 */
export async function drainOutbox(deps: Pick<RelayDeps, "transaction" | "publish">, batchSize = 50): Promise<DrainResult> {
  return deps.transaction(async (db) => {
    const { rows } = await db.query(
      `SELECT id, payload FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    const published: Array<string | number> = [];
    let failure: { id: string | number; error: unknown } | undefined;
    for (const row of rows as OutboxRow[]) {
      try {
        await deps.publish(row.payload);
        published.push(row.id);
      } catch (error) {
        failure = { id: row.id, error };
        break;
      }
    }
    if (published.length > 0) {
      await db.query(`UPDATE outbox SET published_at = now(), attempts = attempts + 1 WHERE id = ANY($1::bigint[])`, [published]);
    }
    if (failure) {
      const reason = failure.error instanceof Error ? failure.error.message : String(failure.error);
      await db.query(`UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, [failure.id, reason]);
    }
    return { claimed: rows.length, published: published.length, ...(failure && { error: failure.error }) };
  });
}

const MAX_BACKOFF_MS = 30_000;

/** Runs `drainOutbox` in a loop: on a timer, immediately when woken, and with backoff while failing. */
export function startOutboxRelay(deps: RelayDeps): OutboxRelay {
  const pollMs = deps.pollIntervalMs ?? 1_000;
  const batchSize = deps.batchSize ?? 50;
  const retentionHours = deps.retentionHours ?? 24;
  const cleanupEveryMs = deps.cleanupIntervalMs ?? 60_000;
  let stopped = false;
  let wakeUp: (() => void) | undefined;
  let lastCleanup = Date.now();

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  async function publishPending(): Promise<boolean> {
    for (;;) {
      const result = await drainOutbox(deps, batchSize);
      if (result.published > 0) deps.log.info({ published: result.published }, "outbox messages published");
      if (result.error !== undefined) {
        deps.log.error({ err: result.error }, "outbox publish failed, will retry");
        return false;
      }
      if (result.claimed < batchSize || stopped) return true;
    }
  }

  async function cleanUp(): Promise<void> {
    if (Date.now() - lastCleanup < cleanupEveryMs) return;
    lastCleanup = Date.now();
    await deps.transaction((db) =>
      db.query(`DELETE FROM outbox WHERE published_at < now() - make_interval(hours => $1::int)`, [retentionHours]),
    );
  }

  const loop = (async () => {
    let failures = 0;
    while (!stopped) {
      try {
        failures = (await publishPending()) ? 0 : failures + 1;
        await cleanUp();
      } catch (err) {
        failures++;
        deps.log.error({ err }, "outbox relay error");
      }
      if (!stopped) await sleep(failures === 0 ? pollMs : Math.min(MAX_BACKOFF_MS, pollMs * 2 ** failures));
    }
  })();

  return {
    wake: () => wakeUp?.(),
    stop: async () => {
      stopped = true;
      wakeUp?.();
      await loop;
    },
  };
}
