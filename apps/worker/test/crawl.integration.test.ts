import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { buildPageTree, drainOutbox, type PageTaskMessage } from "@alteva/core";
import { withTransaction } from "../src/db";
import { fetchPage } from "../src/fetcher";
import { processPage } from "../src/pipeline";
import { createTestDb, postgresAvailable, seedJob, startFixtureServer, type FixtureSite, type TestDb } from "./helpers";

const dbUp = await postgresAvailable();
const log = pino({ level: "silent" });

/**
 * Crawls test/fixtures/site over real HTTP into a real Postgres (the compose database, in a
 * throwaway schema). The flow is the production one minus RabbitMQ: the worker pipeline queues each
 * page's children in the outbox, the real outbox relay drains it, and what it "publishes" lands in an
 * array that stands in for the queue.
 *
 *   /            ─▶ /a, /a#section, /b/, ./b, https://other.example/x, mailto:, /doc.pdf, /missing
 *   /a           ─▶ /, /b, /deep/page
 *   /b           ─▶ /a, https://other.example/y
 *   /deep/page   ─▶ next (= /deep/next), ../a (= /a)
 *   /doc.pdf     application/pdf        /missing   404
 *
 * Links that must collapse into one: /a and /a#section; /b/, ./b and /b.
 * Links that must never be fetched: the external hosts, the mailto, and /deep/next (past depth 2).
 */
describe.skipIf(!dbUp)("crawl of the fixture site", () => {
  let db: TestDb;
  let site: FixtureSite;

  beforeAll(async () => {
    db = await createTestDb();
    site = await startFixtureServer();
  });
  afterAll(async () => {
    site.server.close();
    await db.close();
  });

  interface Crawl {
    jobId: string;
    /** Normalized URLs of the messages processed, in order. */
    processed: string[];
    /** Paths the HTTP server was asked for during this crawl. */
    requested: string[];
  }

  /** Seeds a job, then drains the "queue": process a message, then relay the children it queued. */
  async function crawl(opts: { maxDepth: number; maxPages?: number }): Promise<Crawl> {
    const rootUrl = `${site.baseUrl}/`;
    const { jobId } = await seedJob(db.pool, { url: rootUrl, startHost: site.host, ...opts });
    const requestsBefore = site.requests.length;

    const queue: PageTaskMessage[] = [
      { messageId: "root", jobId, url: rootUrl, depth: 0, parentPageId: null, correlationId: "int-test" },
    ];
    const processed: string[] = [];
    const relay = { transaction: (fn: Parameters<typeof withTransaction>[1]) => withTransaction(db.pool, fn), publish: async (t: PageTaskMessage) => void queue.push(t) };
    for (let msg = queue.shift(); msg; msg = queue.shift()) {
      processed.push(msg.url);
      await processPage({ pool: db.pool, fetchPage }, msg, log);
      await drainOutbox(relay as Parameters<typeof drainOutbox>[0]);
    }
    return { jobId, processed, requested: site.requests.slice(requestsBefore) };
  }

  const path = (url: string) => url.replace(site.baseUrl, "");
  const sorted = (xs: string[]) => [...xs].sort();

  async function pages(jobId: string) {
    return (await db.pool.query("SELECT * FROM pages WHERE job_id = $1 ORDER BY depth, normalized_url", [jobId])).rows;
  }
  const pageAt = async (jobId: string, p: string) => (await pages(jobId)).find((row) => path(row.normalized_url) === p);

  /** "from -> to" for every stored edge, with the site's host stripped for readable assertions. */
  async function edges(jobId: string): Promise<string[]> {
    const { rows } = await db.pool.query(
      `SELECT p.normalized_url AS from_url, e.to_url FROM edges e JOIN pages p ON p.id = e.from_page_id
        WHERE e.job_id = $1`,
      [jobId],
    );
    return sorted(rows.map((r) => `${path(r.from_url)} -> ${path(r.to_url)}`));
  }
  const job = async (jobId: string) => (await db.pool.query("SELECT * FROM jobs WHERE id = $1", [jobId])).rows[0];

  describe("max depth 2", () => {
    let c: Crawl;
    beforeAll(async () => (c = await crawl({ maxDepth: 2 })));

    it("completes the job with every discovered page processed", async () => {
      const row = await job(c.jobId);
      expect(row).toMatchObject({ status: "Completed", pages_discovered: 6, pages_processed: 6 });
      expect(row.started_at).not.toBeNull();
      expect(row.completed_at).not.toBeNull();
      expect(row.completed_at >= row.started_at).toBe(true);
    });

    it("stores one page per normalized URL, with depth and parent", async () => {
      const rows = await pages(c.jobId);
      const parentUrl = (row: { parent_page_id: string | null }) =>
        row.parent_page_id ? path(rows.find((r) => r.id === row.parent_page_id)!.normalized_url) : null;

      expect(rows.map((r) => [path(r.normalized_url), r.depth, parentUrl(r), r.status])).toEqual([
        ["/", 0, null, "done"],
        ["/a", 1, "/", "done"],
        ["/b", 1, "/", "done"],
        ["/doc.pdf", 1, "/", "skipped"],
        ["/missing", 1, "/", "failed"],
        ["/deep/page", 2, "/a", "done"],
      ]);
    });

    it("collapses fragment, trailing-slash and document-relative duplicates into one page and one edge", async () => {
      const fromRoot = (await edges(c.jobId)).filter((e) => e.startsWith("/ -> "));
      expect(fromRoot).toEqual(sorted(["/ -> /a", "/ -> /b", "/ -> /doc.pdf", "/ -> /missing", "/ -> https://other.example/x"]));
    });

    it("stores exactly the expected edges: relative links resolved, external kept, mailto dropped", async () => {
      expect(await edges(c.jobId)).toEqual(
        sorted([
          "/ -> /a",
          "/ -> /b",
          "/ -> /doc.pdf",
          "/ -> /missing",
          "/ -> https://other.example/x",
          "/a -> /",
          "/a -> /b",
          "/a -> /deep/page",
          "/b -> /a",
          "/b -> https://other.example/y",
          "/deep/page -> /a", //         ../a, resolved against /deep/page
          "/deep/page -> /deep/next", // next, resolved against /deep/page: kept as an edge though never crawled
        ]),
      );
    });

    it("computes the domain link ratio from the unique links of each page", async () => {
      const ratio = async (p: string) => {
        const row = await pageAt(c.jobId, p);
        return [row.outgoing_count, row.internal_count, row.domain_link_ratio];
      };
      expect(await ratio("/")).toEqual([5, 4, 0.8]); //          mailto excluded, duplicates counted once
      expect(await ratio("/a")).toEqual([3, 3, 1]);
      expect(await ratio("/b")).toEqual([2, 1, 0.5]);
      expect(await ratio("/deep/page")).toEqual([2, 2, 1]);
    });

    it("records non-HTML as skipped and a 404 as failed, with no ratio or edges", async () => {
      expect(await pageAt(c.jobId, "/doc.pdf")).toMatchObject({
        status: "skipped",
        http_status: 200,
        error: expect.stringContaining("application/pdf"),
        domain_link_ratio: null,
        outgoing_count: null,
      });
      expect(await pageAt(c.jobId, "/missing")).toMatchObject({ status: "failed", http_status: 404, error: "HTTP 404", domain_link_ratio: null });
      expect((await edges(c.jobId)).filter((e) => /^\/(doc\.pdf|missing) -> /.test(e))).toEqual([]);
    });

    it("stops at max depth: no page for /deep/next, though its edge exists", async () => {
      expect(await pageAt(c.jobId, "/deep/next")).toBeUndefined();
      expect(await pageAt(c.jobId, "/deep/page")).toMatchObject({ status: "done", depth: 2 });
    });

    it("asks the server for each page exactly once, and for nothing else", () => {
      expect(sorted(c.requested)).toEqual(sorted(["/", "/a", "/b", "/deep/page", "/doc.pdf", "/missing"]));
      expect(sorted(c.processed.map(path))).toEqual(sorted(c.requested));
    });

    it("builds the nested tree from the stored rows", async () => {
      const tree = buildPageTree(
        (await pages(c.jobId)).map((p) => ({
          id: p.id,
          parentId: p.parent_page_id,
          url: p.normalized_url,
          depth: p.depth,
          status: p.status,
          domainLinkRatio: p.domain_link_ratio,
          outgoingCount: p.outgoing_count,
        })),
      )!;

      const shape = (n: typeof tree): unknown => [path(n.url), n.domainLinkRatio, n.children.map(shape)];
      expect(shape(tree)).toEqual([
        "/",
        0.8,
        [
          ["/a", 1, [["/deep/page", 1, []]]],
          ["/b", 0.5, []],
          ["/doc.pdf", null, []],
          ["/missing", null, []],
        ],
      ]);
    });
  });

  describe("max depth 0", () => {
    let c: Crawl;
    beforeAll(async () => (c = await crawl({ maxDepth: 0 })));

    it("crawls only the start page and completes", async () => {
      expect((await pages(c.jobId)).map((p) => path(p.normalized_url))).toEqual(["/"]);
      expect(await job(c.jobId)).toMatchObject({ status: "Completed", pages_discovered: 1, pages_processed: 1 });
    });

    it("fetches nothing else, yet records and measures the start page's links", async () => {
      expect(c.requested).toEqual(["/"]);
      expect(await edges(c.jobId)).toEqual(
        sorted(["/ -> /a", "/ -> /b", "/ -> /doc.pdf", "/ -> /missing", "/ -> https://other.example/x"]),
      );
      expect(await pageAt(c.jobId, "/")).toMatchObject({ outgoing_count: 5, internal_count: 4, domain_link_ratio: 0.8 });
    });
  });

  describe("max depth 1", () => {
    let c: Crawl;
    beforeAll(async () => (c = await crawl({ maxDepth: 1 })));

    it("crawls the root and its direct links only, and completes", async () => {
      expect(sorted((await pages(c.jobId)).map((p) => path(p.normalized_url)))).toEqual(sorted(["/", "/a", "/b", "/doc.pdf", "/missing"]));
      expect(await job(c.jobId)).toMatchObject({ status: "Completed", pages_discovered: 5, pages_processed: 5 });
    });

    it("never requests the page beyond the limit, but still records the edge to it", async () => {
      expect(c.requested).not.toContain("/deep/page");
      expect(await pageAt(c.jobId, "/deep/page")).toBeUndefined();
      expect(await edges(c.jobId)).toContain("/a -> /deep/page");
    });
  });

  describe("max pages 3", () => {
    let c: Crawl;
    beforeAll(async () => (c = await crawl({ maxDepth: 2, maxPages: 3 })));

    it("stops discovering at the page budget, taking links in document order, and still completes", async () => {
      expect((await pages(c.jobId)).map((p) => path(p.normalized_url))).toEqual(["/", "/a", "/b"]);
      expect(await job(c.jobId)).toMatchObject({ status: "Completed", pages_discovered: 3, pages_processed: 3 });
      expect(sorted(c.requested)).toEqual(sorted(["/", "/a", "/b"]));
    });

    it("records every outgoing link of the crawled pages as an edge, budget or not", async () => {
      expect(await edges(c.jobId)).toContain("/ -> /missing");
      expect(await edges(c.jobId)).toContain("/a -> /deep/page");
    });
  });
});
