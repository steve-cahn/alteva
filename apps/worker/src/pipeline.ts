import { randomUUID } from "node:crypto";
import type { PoolClient, Pool } from "pg";
import type { Logger } from "pino";
import {
  domainLinkRatio,
  enqueueTasks,
  extractLinks,
  isSameDomain,
  normalizeUrl,
  originOf,
  outgoingLinks,
  type PageTaskMessage,
} from "@alteva/core";
import { withTransaction } from "./db";
import { TransientError } from "./errors";
import type { FetchResult } from "./fetcher";

export interface PipelineDeps {
  pool: Pool;
  fetchPage: (url: string) => Promise<FetchResult>;
}

export type PipelineOutcome =
  /** Page was already processed by an earlier delivery: nothing changed. */
  | { kind: "duplicate" }
  /** Job is unknown or already finished/canceled: nothing changed. */
  | { kind: "ignored"; reason: string }
  /**
   * Committed. `children` are the messages for the newly inserted pages. They are already in the
   * outbox, written in the same transaction, and the relay publishes them: nothing to send here.
   */
  | { kind: "processed"; children: PageTaskMessage[]; jobStatus: string };

interface JobRow {
  status: string;
  url: string;
  start_host: string;
  site_origin: string | null;
  max_depth: number;
  max_pages: number;
  pages_discovered: number;
}

interface PageResult {
  status: "done" | "skipped" | "failed";
  httpStatus: number | null;
  error: string | null;
  /** Normalized links found on the page, before site canonicalization; empty unless it was HTML. */
  links: string[];
  /** Where the page actually lives after redirects; only for HTML pages. */
  finalUrl?: string;
}

const FINISHED_STATUSES = new Set(["Completed", "Failed", "Canceled"]);

/**
 * Processes one page task. Fetches first (outside any transaction, so no lock is held during
 * network I/O), then applies the result in a single transaction. The caller publishes `children`
 * after this returns, i.e. after the commit.
 *
 * Permanent fetch outcomes (4xx, non-HTML, oversized) are recorded on the page and returned as a
 * normal result. Transient ones (timeout, reset, DNS, 5xx, 429) throw `TransientError` so the
 * caller can retry later, as do database connection errors from the transaction.
 */
export async function processPage(deps: PipelineDeps, msg: PageTaskMessage, log: Logger): Promise<PipelineOutcome> {
  // Skip the fetch for a job that was canceled (or finished) while this message waited in the queue.
  const skip = await checkJobActive(deps.pool, msg.jobId);
  if (skip) {
    log.info({ url: msg.url, outcome: skip.kind, reason: skip.reason }, "page not processed");
    return skip;
  }
  const fetched = await deps.fetchPage(msg.url);
  if (fetched.kind === "failed" && fetched.retryable) throw new TransientError(fetched.error, fetched.httpStatus);
  return record(deps, msg, toPageResult(fetched), log);
}

/**
 * Gives up on a page: records it as failed and counts it as processed, so the job can still
 * complete. Used when retries are exhausted. Idempotent like any other page result.
 */
export async function failPage(
  deps: PipelineDeps,
  msg: PageTaskMessage,
  failure: { httpStatus: number | null; message: string },
  log: Logger,
): Promise<PipelineOutcome> {
  return record(deps, msg, { status: "failed", httpStatus: failure.httpStatus, error: failure.message, links: [] }, log);
}

async function record(deps: PipelineDeps, msg: PageTaskMessage, result: PageResult, log: Logger): Promise<PipelineOutcome> {
  const outcome = await withTransaction(deps.pool, (client) => applyResult(client, msg, result));
  if (outcome.kind === "processed") {
    log.info(
      { url: msg.url, depth: msg.depth, pageStatus: result.status, links: result.links.length, newChildren: outcome.children.length, jobStatus: outcome.jobStatus },
      "page processed",
    );
  } else {
    log.info({ url: msg.url, outcome: outcome.kind }, "page not processed");
  }
  return outcome;
}

async function checkJobActive(pool: Pool, jobId: string): Promise<Extract<PipelineOutcome, { kind: "ignored" }> | null> {
  const { rows } = await pool.query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [jobId]);
  if (!rows[0]) return { kind: "ignored", reason: "job not found" };
  return FINISHED_STATUSES.has(rows[0].status) ? { kind: "ignored", reason: `job is ${rows[0].status}` } : null;
}

function toPageResult(fetched: FetchResult): PageResult {
  switch (fetched.kind) {
    case "html":
      return {
        status: "done",
        httpStatus: fetched.httpStatus,
        error: null,
        links: extractLinks(fetched.html, fetched.finalUrl),
        finalUrl: fetched.finalUrl,
      };
    case "skipped":
      return { status: "skipped", httpStatus: fetched.httpStatus, error: fetched.reason, links: [] };
    case "failed":
      return { status: "failed", httpStatus: fetched.httpStatus, error: fetched.error, links: [] };
  }
}

async function applyResult(client: PoolClient, msg: PageTaskMessage, result: PageResult): Promise<PipelineOutcome> {
  // Row lock serializes workers on the same job, which makes the max_pages check below atomic.
  const job = await lockJob(client, msg.jobId);
  if (!job) return { kind: "ignored", reason: "job not found" };
  if (FINISHED_STATUSES.has(job.status)) return { kind: "ignored", reason: `job is ${job.status}` };

  const isStartPage = msg.depth === 0;
  const site = siteFor(job, result, isStartPage);
  const links = outgoingLinks(result.links, [msg.url, ...(result.finalUrl ? [result.finalUrl] : [])], site.origin);
  const internalLinks = links.filter((link) => isSameDomain(link, site.host));

  // 1. Claim the page. No row back means an earlier delivery already processed it.
  const pageId = await markPageProcessed(client, msg, result, internalLinks.length, domainLinkRatio(links, site.host), links.length);
  if (pageId === null) return { kind: "duplicate" };

  // The start page decides where the site really lives (it may have redirected).
  if (isStartPage && result.status === "done") await adoptSite(client, msg, pageId, site, result.finalUrl);

  // 2. Every outgoing link is an edge, internal or not.
  await insertEdges(client, msg.jobId, pageId, links);

  // 3. Internal links become child pages while within depth and page budget.
  const childUrls =
    result.status === "done" && msg.depth < job.max_depth ? await insertChildPages(client, msg, job, pageId, internalLinks) : [];

  // 4. Their messages go into the outbox in this same transaction, so the new pages and the work
  //    to crawl them are committed together or not at all.
  const children = childUrls.map((url) => ({
    messageId: randomUUID(),
    jobId: msg.jobId,
    url,
    depth: msg.depth + 1,
    parentPageId: Number(pageId),
    correlationId: msg.correlationId,
  }));
  await enqueueTasks(client, children);

  // 5. Progress. Completed when every discovered page has been processed; Failed when the start
  //    page itself could not be crawled, since there is nothing to report.
  const jobStatus = await updateJobProgress(client, msg.jobId, childUrls.length, isStartPage ? startPageFailure(result) : null);

  return { kind: "processed", jobStatus, children };
}

/**
 * The origin and host that count as "the site". Normally what the job already knows; for the start
 * page it is where the fetch actually ended up, so a redirect (http to https, to www, or to another
 * domain) does not turn every internal link into an external one.
 */
function siteFor(job: JobRow, result: PageResult, isStartPage: boolean): { origin: string; host: string } {
  if (isStartPage && result.finalUrl) {
    const origin = originOf(result.finalUrl);
    return { origin, host: new URL(origin).hostname };
  }
  return { origin: job.site_origin ?? originOf(job.url), host: job.start_host };
}

/** Records the real origin on the job and gives the start page its final address. */
async function adoptSite(
  client: PoolClient,
  msg: PageTaskMessage,
  pageId: string,
  site: { origin: string; host: string },
  finalUrl: string | undefined,
): Promise<void> {
  await client.query("UPDATE jobs SET site_origin = $2, start_host = $3 WHERE id = $1", [msg.jobId, site.origin, site.host]);
  const finalNormalized = finalUrl ? normalizeUrl(finalUrl) : null;
  if (finalNormalized && finalNormalized !== msg.url) {
    // Otherwise a link back to the final address would add the start page a second time.
    await client.query("UPDATE pages SET normalized_url = $2 WHERE id = $1", [pageId, finalNormalized]);
  }
}

function startPageFailure(result: PageResult): string | null {
  if (result.status === "failed") return `Could not fetch the start page: ${result.error}`;
  if (result.status === "skipped") return `The start page cannot be crawled: ${result.error}`;
  return null;
}

async function lockJob(client: PoolClient, jobId: string): Promise<JobRow | null> {
  const { rows } = await client.query<JobRow>(
    "SELECT status, url, start_host, site_origin, max_depth, max_pages, pages_discovered FROM jobs WHERE id = $1 FOR UPDATE",
    [jobId],
  );
  return rows[0] ?? null;
}

/** Returns the page id, or null when the page is not `queued` (duplicate delivery). */
async function markPageProcessed(
  client: PoolClient,
  msg: PageTaskMessage,
  result: PageResult,
  internalCount: number,
  ratio: number,
  outgoingCount: number,
): Promise<string | null> {
  const isHtml = result.status === "done";
  const { rows } = await client.query<{ id: string }>(
    `UPDATE pages
        SET status = $3, domain_link_ratio = $4, outgoing_count = $5, internal_count = $6,
            http_status = $7, error = $8, processed_at = now()
      WHERE job_id = $1 AND normalized_url = $2 AND status = 'queued'
      RETURNING id`,
    [
      msg.jobId,
      msg.url,
      result.status,
      isHtml ? ratio : null,
      isHtml ? outgoingCount : null,
      isHtml ? internalCount : null,
      result.httpStatus,
      result.error,
    ],
  );
  return rows[0]?.id ?? null;
}

async function insertEdges(client: PoolClient, jobId: string, fromPageId: string, links: string[]): Promise<void> {
  if (links.length === 0) return;
  await client.query(
    `INSERT INTO edges (job_id, from_page_id, to_url)
     SELECT $1::uuid, $2::bigint, unnest($3::text[])
     ON CONFLICT DO NOTHING`,
    [jobId, fromPageId, links],
  );
}

/**
 * Inserts links that are new to this job, at most as many as the page budget still allows.
 * Safe without extra guards because `lockJob` holds the job row for the whole transaction, so
 * `pages_discovered` cannot change between the read and the increment.
 */
async function insertChildPages(
  client: PoolClient,
  msg: PageTaskMessage,
  job: JobRow,
  parentPageId: string,
  candidates: string[],
): Promise<string[]> {
  const budget = job.max_pages - job.pages_discovered;
  if (budget <= 0 || candidates.length === 0) return [];

  const known = await client.query<{ normalized_url: string }>(
    "SELECT normalized_url FROM pages WHERE job_id = $1 AND normalized_url = ANY($2::text[])",
    [msg.jobId, candidates],
  );
  const knownUrls = new Set(known.rows.map((r) => r.normalized_url));
  const fresh = candidates.filter((url) => !knownUrls.has(url)).slice(0, budget);
  if (fresh.length === 0) return [];

  const { rows } = await client.query<{ normalized_url: string }>(
    `INSERT INTO pages (job_id, normalized_url, parent_page_id, depth)
     SELECT $1::uuid, url, $2::bigint, $3::int FROM unnest($4::text[]) AS url
     ON CONFLICT (job_id, normalized_url) DO NOTHING
     RETURNING normalized_url`,
    [msg.jobId, parentPageId, msg.depth + 1, fresh],
  );
  return rows.map((r) => r.normalized_url);
}

/**
 * Counts this page as processed and its new children as discovered, in one statement. Marks the
 * job Running on its first message (keeping the original started_at), Completed once every
 * discovered page has been processed, or Failed with `failure` as the reason. All right-hand sides
 * read the pre-update row.
 */
async function updateJobProgress(client: PoolClient, jobId: string, newChildren: number, failure: string | null): Promise<string> {
  const { rows } = await client.query<{ status: string }>(
    `UPDATE jobs
        SET pages_processed  = pages_processed + 1,
            pages_discovered = pages_discovered + $2::int,
            started_at       = COALESCE(started_at, now()),
            status           = CASE WHEN $3::text IS NOT NULL THEN 'Failed'
                                    WHEN pages_processed + 1 = pages_discovered + $2::int THEN 'Completed'
                                    ELSE 'Running' END,
            failure_reason   = COALESCE($3::text, failure_reason),
            completed_at     = CASE WHEN $3::text IS NOT NULL
                                      OR pages_processed + 1 = pages_discovered + $2::int THEN now() END
      WHERE id = $1
      RETURNING status`,
    [jobId, newChildren, failure],
  );
  return rows[0].status;
}
