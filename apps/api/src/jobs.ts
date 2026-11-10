import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { enqueueTasks, isSameDomain, type PageTaskMessage, type PageTreeRow } from "@alteva/core";
import { withTransaction } from "./db";
import { encodeCursor, JOB_STATUSES, type Cursor, type JobStatus } from "./validation";

export interface JobView {
  id: string;
  url: string;
  status: string;
  maxDepth: number;
  maxPages: number;
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  progress: { pagesDiscovered: number; pagesProcessed: number };
}

interface JobRow {
  id: string;
  url: string;
  status: string;
  max_depth: number;
  max_pages: number;
  failure_reason: string | null;
  pages_discovered: number;
  pages_processed: number;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

const JOB_COLUMNS =
  "id, url, status, max_depth, max_pages, failure_reason, pages_discovered, pages_processed, created_at, started_at, completed_at";

function toJobView(row: JobRow): JobView {
  return {
    id: row.id,
    url: row.url,
    status: row.status,
    maxDepth: row.max_depth,
    maxPages: row.max_pages,
    failureReason: row.failure_reason,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    progress: { pagesDiscovered: row.pages_discovered, pagesProcessed: row.pages_processed },
  };
}

/**
 * Inserts the job, its root page and the root message together, in one transaction. The message goes
 * to the outbox, not straight to the broker, so a job can never exist without its first message
 * (or the reverse), and creating a job does not depend on the broker being up. The root counts as
 * discovered (pages_discovered = 1), which the worker relies on: the job completes when processed
 * catches up with discovered.
 */
export async function createJob(
  pool: Pool,
  input: { url: string; startHost: string; maxDepth: number; maxPages: number; correlationId: string },
): Promise<string> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO jobs (url, start_host, max_depth, max_pages, pages_discovered)
       VALUES ($1, $2, $3, $4, 1) RETURNING id`,
      [input.url, input.startHost, input.maxDepth, input.maxPages],
    );
    const jobId = rows[0].id;
    await client.query("INSERT INTO pages (job_id, normalized_url, depth) VALUES ($1, $2, 0)", [jobId, input.url]);
    const rootTask: PageTaskMessage = {
      messageId: randomUUID(),
      jobId,
      url: input.url,
      depth: 0,
      parentPageId: null,
      correlationId: input.correlationId,
    };
    await enqueueTasks(client, [rootTask]);
    return jobId;
  });
}

/**
 * Fails jobs that have been unfinished for longer than `maxAgeMinutes`. A job can get stuck if
 * messages are lost (see the README's known limitations); without this it would stay Running
 * forever. The worker ignores a Failed job's remaining messages. Returns the ids it failed.
 */
export async function failStaleJobs(pool: Pool, maxAgeMinutes: number): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE jobs
        SET status = 'Failed', completed_at = now(),
            failure_reason = 'Timed out: the crawl did not finish within ' || $1::int || ' minutes'
      WHERE status IN ('Pending', 'Running') AND created_at < now() - make_interval(mins => $1::int)
      RETURNING id`,
    [maxAgeMinutes],
  );
  return rows.map((r) => r.id);
}

export async function getJob(pool: Pool, id: string): Promise<JobView | null> {
  const { rows } = await pool.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = $1`, [id]);
  return rows[0] ? toJobView(rows[0]) : null;
}

/** Cancels a Pending or Running job. Returns null when the job does not exist or already finished. */
export async function cancelJob(pool: Pool, id: string): Promise<JobView | null> {
  const { rows } = await pool.query<JobRow>(
    `UPDATE jobs SET status = 'Canceled', completed_at = now()
      WHERE id = $1 AND status IN ('Pending', 'Running')
      RETURNING ${JOB_COLUMNS}`,
    [id],
  );
  return rows[0] ? toJobView(rows[0]) : null;
}

export interface JobPage {
  items: JobView[];
  nextCursor: string | null;
}

/**
 * Keyset pagination, newest first, optionally only jobs in the given statuses. Ordering by
 * (created_at, id) makes the position unique even when rows share a timestamp, and the cursor
 * carries created_at as Postgres text because a JS Date would truncate microseconds and could skip
 * or repeat rows. The cursor is just a position in that ordering, so it stays valid under any
 * filter: the client passes the same filter again with it.
 */
export async function listJobs(pool: Pool, limit: number, cursor: Cursor | null, statuses: JobStatus[] | null = null): Promise<JobPage> {
  const { rows } = await pool.query<JobRow & { cursor_ts: string }>(
    `SELECT ${JOB_COLUMNS}, created_at::text AS cursor_ts
       FROM jobs
      WHERE ($4::text[] IS NULL OR status = ANY($4::text[]))
        AND ($1::timestamptz IS NULL OR (created_at, id) < ($1::timestamptz, $2::uuid))
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1, statuses],
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const hasMore = rows.length > limit;
  return {
    items: page.map(toJobView),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.cursor_ts, id: last.id }) : null,
  };
}

export interface JobCounts {
  total: number;
  byStatus: Record<JobStatus, number>;
}

/**
 * How many jobs there are in each status, over the whole history. One grouped pass over the table
 * (about 19 ms at 200,000 jobs, growing linearly): fine for loading a history page. If the history
 * grew into the millions, keep these counters up to date instead of counting.
 */
export async function getJobCounts(pool: Pool): Promise<JobCounts> {
  const { rows } = await pool.query<{ status: JobStatus; n: number }>("SELECT status, count(*)::int AS n FROM jobs GROUP BY status");
  const byStatus = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0])) as Record<JobStatus, number>;
  for (const { status, n } of rows) byStatus[status] = n;
  return { total: rows.reduce((sum, r) => sum + r.n, 0), byStatus };
}

export async function getTreeRows(pool: Pool, jobId: string): Promise<PageTreeRow[]> {
  const { rows } = await pool.query(
    `SELECT id, parent_page_id, normalized_url, depth, status, domain_link_ratio, outgoing_count
       FROM pages WHERE job_id = $1 ORDER BY id`,
    [jobId],
  );
  return rows.map((r) => ({
    id: r.id,
    parentId: r.parent_page_id,
    url: r.normalized_url,
    depth: r.depth,
    status: r.status,
    domainLinkRatio: r.domain_link_ratio,
    outgoingCount: r.outgoing_count,
  }));
}

export interface PageCounts {
  queued: number;
  done: number;
  skipped: number;
  failed: number;
}

/** Pages of a job by status: one grouped read over the (job_id, status) index. */
export async function getPageCounts(pool: Pool, jobId: string): Promise<PageCounts> {
  const { rows } = await pool.query<{ status: keyof PageCounts; n: number }>(
    "SELECT status, count(*)::int AS n FROM pages WHERE job_id = $1 GROUP BY status",
    [jobId],
  );
  const counts: PageCounts = { queued: 0, done: 0, skipped: 0, failed: 0 };
  for (const { status, n } of rows) counts[status] = n;
  return counts;
}

/** Most links returned for one page; `total` always says how many there are. */
export const PAGE_LINKS_LIMIT = 1000;

export interface PageLinks {
  pageId: string;
  url: string;
  total: number;
  links: Array<{ url: string; isInternal: boolean }>;
}

/**
 * The outgoing links stored for one page, or null when the page is not part of this job. A link is
 * internal when it is on the job's starting domain, by the same rule the crawler used.
 */
export async function getPageLinks(pool: Pool, jobId: string, pageId: string): Promise<PageLinks | null> {
  const page = await pool.query<{ normalized_url: string; start_host: string }>(
    `SELECT p.normalized_url, j.start_host FROM pages p JOIN jobs j ON j.id = p.job_id WHERE p.job_id = $1 AND p.id = $2`,
    [jobId, pageId],
  );
  if (!page.rows[0]) return null;
  const { rows } = await pool.query<{ to_url: string; total: number }>(
    `SELECT to_url, count(*) OVER ()::int AS total
       FROM edges WHERE job_id = $1 AND from_page_id = $2 ORDER BY to_url LIMIT $3`,
    [jobId, pageId, PAGE_LINKS_LIMIT],
  );
  return {
    pageId,
    url: page.rows[0].normalized_url,
    total: rows[0]?.total ?? 0,
    links: rows.map((r) => ({ url: r.to_url, isInternal: isSameDomain(r.to_url, page.rows[0].start_host) })),
  };
}
