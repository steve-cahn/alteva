import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import type { PageTaskMessage } from "@alteva/core";
import type { FetchResult } from "../src/fetcher";
import { fetchPage } from "../src/fetcher";
import { processPage, type PipelineOutcome } from "../src/pipeline";
import { createTestDb, postgresAvailable, seedJob, startFixtureServer, type TestDb } from "./helpers";

const dbUp = await postgresAvailable();
const log = pino({ level: "silent" });

/** Snapshot of everything a duplicate delivery could corrupt. */
async function snapshot(db: TestDb, jobId: string) {
  const q = async (sql: string) => (await db.pool.query(sql, [jobId])).rows;
  return {
    job: (await q("SELECT status, pages_discovered, pages_processed, started_at, completed_at FROM jobs WHERE id = $1"))[0],
    pages: await q(
      "SELECT normalized_url, status, depth, parent_page_id, domain_link_ratio, outgoing_count, internal_count, http_status, processed_at FROM pages WHERE job_id = $1 ORDER BY normalized_url",
    ),
    edges: await q("SELECT from_page_id, to_url FROM edges WHERE job_id = $1 ORDER BY from_page_id, to_url"),
  };
}

describe.skipIf(!dbUp)("idempotency: at-least-once delivery", () => {
  let db: TestDb;
  beforeAll(async () => (db = await createTestDb()));
  afterAll(async () => db.close());

  const ROOT = "https://site.test/";
  const page: FetchResult = {
    kind: "html",
    httpStatus: 200,
    finalUrl: ROOT,
    html: '<a href="/a">a</a><a href="/b">b</a><a href="https://other.test/x">x</a>',
  };
  const msg = (jobId: string): PageTaskMessage => ({ messageId: "m", jobId, url: ROOT, depth: 0, parentPageId: null, correlationId: "c" });
  const deps = () => ({ pool: db.pool, fetchPage: async () => page });

  it("processing the same message twice creates no duplicate pages or edges and does not double-count progress", async () => {
    const { jobId } = await seedJob(db.pool, { url: ROOT, startHost: "site.test" });

    const first = await processPage(deps(), msg(jobId), log);
    const afterFirst = await snapshot(db, jobId);
    const second = await processPage(deps(), msg(jobId), log);
    const afterSecond = await snapshot(db, jobId);

    expect(first).toMatchObject({ kind: "processed" });
    expect(second).toEqual({ kind: "duplicate" });
    expect(afterSecond).toEqual(afterFirst); // byte-for-byte: rows, counters and timestamps untouched

    expect(afterSecond.pages).toHaveLength(3); // root + /a + /b
    expect(afterSecond.edges).toHaveLength(3);
    expect(afterSecond.job).toMatchObject({ pages_processed: 1, pages_discovered: 3, status: "Running" });
  });

  it("publishes children only once when two deliveries race", async () => {
    const { jobId } = await seedJob(db.pool, { url: ROOT, startHost: "site.test" });

    const outcomes = await Promise.all([processPage(deps(), msg(jobId), log), processPage(deps(), msg(jobId), log)]);

    expect(outcomes.map((o) => o.kind).sort()).toEqual(["duplicate", "processed"]);
    const processed = outcomes.find((o): o is Extract<PipelineOutcome, { kind: "processed" }> => o.kind === "processed")!;
    expect(processed.children).toHaveLength(2);
    const state = await snapshot(db, jobId);
    expect(state.pages).toHaveLength(3);
    expect(state.edges).toHaveLength(3);
    expect(state.job).toMatchObject({ pages_processed: 1, pages_discovered: 3 });
  });

  describe("a whole crawl where the broker delivers every message twice", () => {
    let site: { server: Server; baseUrl: string; host: string };
    afterAll(() => site?.server.close());

    async function crawl(duplicateEveryMessage: boolean) {
      site ??= await startFixtureServer();
      const rootUrl = `${site.baseUrl}/`;
      const { jobId } = await seedJob(db.pool, { url: rootUrl, startHost: site.host, maxDepth: 2 });
      const queue: PageTaskMessage[] = [{ messageId: "r", jobId, url: rootUrl, depth: 0, parentPageId: null, correlationId: "c" }];
      let deliveries = 0;
      for (let m = queue.shift(); m; m = queue.shift()) {
        const copies = duplicateEveryMessage ? [m, m] : [m];
        for (const copy of copies) {
          deliveries++;
          const outcome = await processPage({ pool: db.pool, fetchPage }, copy, log);
          if (outcome.kind === "processed") queue.push(...outcome.children);
        }
      }
      return { jobId, deliveries, state: await snapshot(db, jobId) };
    }

    // Row ids and timestamps differ between two jobs, so compare shape: what was crawled and how.
    const shape = (s: Awaited<ReturnType<typeof snapshot>>) => ({
      job: { status: s.job.status, discovered: s.job.pages_discovered, processed: s.job.pages_processed },
      pages: s.pages.map((p) => [p.normalized_url.replace(/^http:\/\/127\.0\.0\.1:\d+/, ""), p.status, p.depth, p.domain_link_ratio, p.outgoing_count]),
      edgeCount: s.edges.length,
    });

    it("ends in exactly the state of a crawl with no duplicates", async () => {
      const once = await crawl(false);
      const twice = await crawl(true);

      expect(twice.deliveries).toBe(once.deliveries * 2);
      expect(shape(twice.state)).toEqual(shape(once.state));
      expect(shape(twice.state).job).toEqual({ status: "Completed", discovered: 6, processed: 6 });
      expect(twice.state.pages).toHaveLength(6);
      expect(twice.state.edges).toHaveLength(12);
    }, 30_000); // two whole crawls over real HTTP and a database: allow for a slow, busy machine
  });
});
