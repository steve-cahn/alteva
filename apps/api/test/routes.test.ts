import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startOutboxRelay, type PageTaskMessage } from "@alteva/core";
import { buildApp } from "../src/app";
import { withTransaction } from "../src/db";
import { failStaleJobs } from "../src/jobs";
import { createTestDb, eventually, postgresAvailable, type TestDb } from "./helpers";

const dbUp = await postgresAvailable();
const ORIGIN = "http://localhost:3100";

/** Stands in for the broker connection: the routes only ask whether it is reachable. */
const broker = { healthy: true, isHealthy: () => broker.healthy };
/** Records the relay being nudged after a job is committed. */
const outbox = { wakes: 0, wake: () => void outbox.wakes++ };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!dbUp)("api routes (postgres)", () => {
  let db: TestDb;
  let app: FastifyInstance;
  const logLines: Record<string, unknown>[] = [];

  beforeAll(async () => {
    db = await createTestDb();
    const stream = new Writable({
      write(chunk, _enc, done) {
        logLines.push(JSON.parse(chunk.toString()));
        done();
      },
    });
    app = await buildApp({
      pool: db.pool,
      broker,
      outbox,
      corsOrigins: [ORIGIN],
      defaultMaxDepth: 2,
      defaultMaxPages: 200,
      logger: { level: "info", stream },
    });
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });
  beforeEach(async () => {
    await db.pool.query("DELETE FROM jobs");
    await db.pool.query("DELETE FROM outbox");
    broker.healthy = true;
    outbox.wakes = 0;
    logLines.length = 0;
  });

  const post = (url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, payload: payload as object, headers });
  const get = (url: string) => app.inject({ method: "GET", url });
  const rows = async (sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows;
  const errorOf = (res: { json: () => any }) => res.json().error;

  async function seedJob(opts: { createdAt?: string; status?: string; url?: string } = {}) {
    const { rows } = await db.pool.query(
      `INSERT INTO jobs (url, start_host, status, created_at, pages_discovered)
       VALUES ($1, 'site.test', $2, COALESCE($3::timestamptz, now()), 1) RETURNING id`,
      [opts.url ?? "https://site.test/", opts.status ?? "Pending", opts.createdAt ?? null],
    );
    return rows[0].id as string;
  }

  describe("POST /api/jobs", () => {
    it("creates the job, its root page and the root message together, and answers 202 with a Location", async () => {
      const res = await post("/api/jobs", { url: "https://Site.test/Start/#x", maxDepth: 3 }, { "x-correlation-id": "corr-123" });

      expect(res.statusCode).toBe(202);
      const { jobId } = res.json();
      expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.headers.location).toBe(`/api/jobs/${jobId}`);

      expect((await rows("SELECT * FROM jobs WHERE id = $1", [jobId]))[0]).toMatchObject({
        url: "https://site.test/Start",
        start_host: "site.test",
        max_depth: 3,
        max_pages: 200,
        status: "Pending",
        pages_discovered: 1,
        pages_processed: 0,
      });
      expect(await rows("SELECT normalized_url, depth, status, parent_page_id FROM pages WHERE job_id = $1", [jobId])).toEqual([
        { normalized_url: "https://site.test/Start", depth: 0, status: "queued", parent_page_id: null },
      ]);
      // The root message is in the outbox, committed with the job, and the relay was nudged.
      expect(await rows("SELECT payload, published_at FROM outbox")).toEqual([
        {
          payload: { messageId: expect.any(String), jobId, url: "https://site.test/Start", depth: 0, parentPageId: null, correlationId: "corr-123" },
          published_at: null,
        },
      ]);
      expect(outbox.wakes).toBe(1);
    });

    it.each([0, 6, 200])("accepts maxDepth %i and stores it", async (maxDepth) => {
      const res = await post("/api/jobs", { url: "https://site.test", maxDepth });
      expect(res.statusCode).toBe(202);
      expect((await rows("SELECT max_depth FROM jobs WHERE id = $1", [res.json().jobId]))[0].max_depth).toBe(maxDepth);
    });

    it("defaults maxDepth to 2", async () => {
      const { jobId } = (await post("/api/jobs", { url: "https://site.test" })).json();
      expect((await rows("SELECT max_depth FROM jobs WHERE id = $1", [jobId]))[0].max_depth).toBe(2);
    });

    it.each([
      ["a non-http url", { url: "ftp://site.test" }, "url"],
      ["a missing url", {}, "url"],
      ["a negative maxDepth", { url: "https://site.test", maxDepth: -1 }, "maxDepth"],
      ["a maxDepth beyond the page limit", { url: "https://site.test", maxDepth: 201 }, "maxDepth"],
      ["a fractional maxDepth", { url: "https://site.test", maxDepth: 1.5 }, "maxDepth"],
    ])("rejects %s with a 400 and creates nothing", async (_name, body, field) => {
      const res = await post("/api/jobs", body);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res)).toMatchObject({ code: "VALIDATION_ERROR", details: [{ field }] });
      expect(await rows("SELECT 1 FROM jobs")).toHaveLength(0);
      expect(await rows("SELECT 1 FROM outbox")).toHaveLength(0);
    });

    it("answers 400 to malformed JSON and an empty body, in the standard error shape", async () => {
      const bad = await app.inject({ method: "POST", url: "/api/jobs", payload: "{nope", headers: { "content-type": "application/json" } });
      expect(bad.statusCode).toBe(400);
      expect(errorOf(bad)).toMatchObject({ code: "BAD_REQUEST", correlationId: expect.any(String) });
      expect((await post("/api/jobs")).statusCode).toBe(400);
    });

    it("still creates the job when the broker is down: the message waits in the outbox", async () => {
      broker.healthy = false;
      const res = await post("/api/jobs", { url: "https://site.test" });

      expect(res.statusCode).toBe(202);
      expect((await rows("SELECT status FROM jobs WHERE id = $1", [res.json().jobId]))[0].status).toBe("Pending");
      expect(await rows("SELECT published_at FROM outbox")).toEqual([{ published_at: null }]);
    });

    it("leaves neither a job nor a message behind when the request is invalid", async () => {
      await post("/api/jobs", { url: "ftp://x" });
      expect(await rows("SELECT 1 FROM jobs")).toHaveLength(0);
      expect(await rows("SELECT 1 FROM outbox")).toHaveLength(0);
      expect(outbox.wakes).toBe(0);
    });

    it("gets the root message to the broker through the relay, with the request's correlation id", async () => {
      const sent: PageTaskMessage[] = [];
      let up = false;
      const relay = startOutboxRelay({
        transaction: (fn) => withTransaction(db.pool, fn),
        publish: async (task) => {
          if (!up) throw new Error("broker down");
          sent.push(task);
        },
        log: { info() {}, warn() {}, error() {} },
        pollIntervalMs: 20,
      });
      try {
        const { jobId } = (await post("/api/jobs", { url: "https://site.test" }, { "x-correlation-id": "relay-me" })).json();
        await eventually(async () => (await rows("SELECT attempts FROM outbox"))[0].attempts > 0); // it has tried, and failed
        expect(sent).toEqual([]); // broker still down: nothing lost, nothing sent

        up = true;
        relay.wake();
        await eventually(() => sent.length === 1);
        expect(sent).toEqual([expect.objectContaining({ jobId, depth: 0, correlationId: "relay-me" })]);
        // The relay marks the row in the same transaction, just after publishing: wait for that too.
        await eventually(async () => (await rows("SELECT published_at FROM outbox"))[0].published_at !== null);
      } finally {
        await relay.stop();
      }
    }, 10_000);
  });

  describe("GET /api/jobs/:id", () => {
    it("returns status, timestamps, failure reason and progress counts", async () => {
      const { rows: r } = await db.pool.query(
        `INSERT INTO jobs (url, start_host, status, pages_discovered, pages_processed, started_at, failure_reason)
         VALUES ('https://site.test/', 'site.test', 'Running', 9, 4, '2026-01-02T03:04:05Z', 'partial') RETURNING id`,
      );
      const res = await get(`/api/jobs/${r[0].id}`);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        id: r[0].id,
        url: "https://site.test/",
        status: "Running",
        maxDepth: 2,
        maxPages: 200,
        failureReason: "partial",
        createdAt: expect.any(String),
        startedAt: "2026-01-02T03:04:05.000Z",
        completedAt: null,
        progress: { pagesDiscovered: 9, pagesProcessed: 4 },
        pageCounts: { queued: 0, done: 0, skipped: 0, failed: 0 },
      });
    });

    it("breaks the pages down by status", async () => {
      const id = await seedJob({ status: "Running" });
      for (const [i, status] of ["done", "done", "done", "queued", "queued", "skipped", "failed"].entries()) {
        await db.pool.query("INSERT INTO pages (job_id, normalized_url, depth, status) VALUES ($1, $2, 1, $3)", [id, `https://site.test/${i}`, status]);
      }
      expect((await get(`/api/jobs/${id}`)).json().pageCounts).toEqual({ queued: 2, done: 3, skipped: 1, failed: 1 });
    });

    it("counts only the requested job's pages", async () => {
      const mine = await seedJob();
      const other = await seedJob();
      await db.pool.query("INSERT INTO pages (job_id, normalized_url, depth, status) VALUES ($1, 'https://site.test/x', 1, 'done')", [other]);
      expect((await get(`/api/jobs/${mine}`)).json().pageCounts).toEqual({ queued: 0, done: 0, skipped: 0, failed: 0 });
    });

    it("404s for an unknown job and 400s for an id that is not a UUID", async () => {
      const missing = await get("/api/jobs/00000000-0000-0000-0000-000000000000");
      expect(missing.statusCode).toBe(404);
      expect(errorOf(missing)).toMatchObject({ code: "NOT_FOUND" });

      const bad = await get("/api/jobs/not-a-uuid");
      expect(bad.statusCode).toBe(400);
      expect(errorOf(bad)).toMatchObject({ code: "VALIDATION_ERROR", details: [{ field: "id" }] });
    });
  });

  describe("GET /api/jobs/:id/tree", () => {
    it("nests pages by parent_page_id with url, depth, status, ratio and outgoing count", async () => {
      const jobId = await seedJob({ status: "Running" });
      const page = async (url: string, parent: string | null, depth: number, status: string, ratio: number | null, outgoing: number | null) =>
        (
          await db.pool.query(
            `INSERT INTO pages (job_id, normalized_url, parent_page_id, depth, status, domain_link_ratio, outgoing_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [jobId, url, parent, depth, status, ratio, outgoing],
          )
        ).rows[0].id as string;
      const root = await page("https://site.test/", null, 0, "done", 0.75, 4);
      const a = await page("https://site.test/a", root, 1, "done", 1, 2);
      const b = await page("https://site.test/b", root, 1, "failed", null, null);
      const ax = await page("https://site.test/a/x", a, 2, "queued", null, null);

      const res = await get(`/api/jobs/${jobId}/tree`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        jobId,
        status: "Running",
        tree: {
          id: root,
          url: "https://site.test/",
          depth: 0,
          status: "done",
          domainLinkRatio: 0.75,
          outgoingCount: 4,
          children: [
            {
              id: a,
              url: "https://site.test/a",
              depth: 1,
              status: "done",
              domainLinkRatio: 1,
              outgoingCount: 2,
              children: [{ id: ax, url: "https://site.test/a/x", depth: 2, status: "queued", domainLinkRatio: null, outgoingCount: null, children: [] }],
            },
            { id: b, url: "https://site.test/b", depth: 1, status: "failed", domainLinkRatio: null, outgoingCount: null, children: [] },
          ],
        },
      });
    });

    it("returns the root alone for a just-created job", async () => {
      const { jobId } = (await post("/api/jobs", { url: "https://site.test" })).json();
      const { tree } = (await get(`/api/jobs/${jobId}/tree`)).json();
      expect(tree).toMatchObject({ url: "https://site.test/", depth: 0, status: "queued", children: [] });
    });

    it("404s for an unknown job", async () => {
      expect((await get("/api/jobs/00000000-0000-0000-0000-000000000000/tree")).statusCode).toBe(404);
    });
  });

  describe("GET /api/jobs/:id/pages/:pageId/links", () => {
    async function pageWithLinks(jobId: string, url: string, links: string[]) {
      const { rows: r } = await db.pool.query("INSERT INTO pages (job_id, normalized_url, depth, status) VALUES ($1, $2, 1, 'done') RETURNING id", [jobId, url]);
      for (const to of links) await db.pool.query("INSERT INTO edges (job_id, from_page_id, to_url) VALUES ($1, $2, $3)", [jobId, r[0].id, to]);
      return r[0].id as string;
    }
    const linksUrl = (jobId: string, pageId: string) => `/api/jobs/${jobId}/pages/${pageId}/links`;

    it("lists a page's outgoing links, marked internal or external by the job's starting domain", async () => {
      const jobId = await seedJob(); // start host: site.test
      const pageId = await pageWithLinks(jobId, "https://site.test/a", [
        "https://site.test/b",
        "https://www.site.test/c", // www counts as the same site
        "https://other.test/x",
        "https://blog.site.test/y", // another subdomain is external
      ]);

      const res = await get(linksUrl(jobId, pageId));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        pageId,
        url: "https://site.test/a",
        total: 4,
        truncated: false,
        links: [
          { url: "https://blog.site.test/y", isInternal: false },
          { url: "https://other.test/x", isInternal: false },
          { url: "https://site.test/b", isInternal: true },
          { url: "https://www.site.test/c", isInternal: true },
        ],
      });
    });

    it("returns an empty list for a page with no links", async () => {
      const jobId = await seedJob();
      const pageId = await pageWithLinks(jobId, "https://site.test/empty", []);
      expect((await get(linksUrl(jobId, pageId))).json()).toMatchObject({ total: 0, truncated: false, links: [] });
    });

    it("returns only that page's links", async () => {
      const jobId = await seedJob();
      const one = await pageWithLinks(jobId, "https://site.test/1", ["https://site.test/x"]);
      await pageWithLinks(jobId, "https://site.test/2", ["https://site.test/y", "https://site.test/z"]);
      expect((await get(linksUrl(jobId, one))).json().links).toEqual([{ url: "https://site.test/x", isInternal: true }]);
    });

    it("caps the list at 1000 links and says how many there really are", async () => {
      const jobId = await seedJob();
      const { rows: r } = await db.pool.query("INSERT INTO pages (job_id, normalized_url, depth, status) VALUES ($1, 'https://site.test/big', 1, 'done') RETURNING id", [jobId]);
      await db.pool.query(
        "INSERT INTO edges (job_id, from_page_id, to_url) SELECT $1, $2, 'https://site.test/p' || lpad(n::text, 5, '0') FROM generate_series(1, 1200) n",
        [jobId, r[0].id],
      );
      const body = (await get(linksUrl(jobId, r[0].id))).json();
      expect(body.links).toHaveLength(1000);
      expect(body).toMatchObject({ total: 1200, truncated: true });
    });

    it("404s for an unknown page, for a page that belongs to another job, and for an unknown job", async () => {
      const mine = await seedJob();
      const other = await seedJob();
      const otherPage = await pageWithLinks(other, "https://site.test/o", ["https://site.test/x"]);

      expect((await get(linksUrl(mine, "999999"))).statusCode).toBe(404);
      expect((await get(linksUrl(mine, otherPage))).statusCode).toBe(404); // not leaked across jobs
      expect((await get(linksUrl("00000000-0000-0000-0000-000000000000", otherPage))).statusCode).toBe(404);
    });

    it.each(["abc", "0", "-1", "1.5", "1e3", "12345678901234567890", "1;drop"])("400s for page id %j", async (pageId) => {
      const jobId = await seedJob();
      const res = await get(linksUrl(jobId, pageId));
      expect(res.statusCode).toBe(400);
      expect(errorOf(res)).toMatchObject({ code: "VALIDATION_ERROR", details: [{ field: "pageId" }] });
    });

    it("400s for a malformed job id", async () => {
      expect((await get("/api/jobs/nope/pages/1/links")).statusCode).toBe(400);
    });
  });

  describe("GET /api/jobs (history)", () => {
    /** Walks every page of results and returns the ids in order, plus the page sizes. */
    async function walk(limit: number) {
      const ids: string[] = [];
      const sizes: number[] = [];
      let cursor: string | null = null;
      do {
        const res = await get(`/api/jobs?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
        expect(res.statusCode).toBe(200);
        const body: { items: { id: string }[]; nextCursor: string | null } = res.json();
        ids.push(...body.items.map((i) => i.id));
        sizes.push(body.items.length);
        cursor = body.nextCursor;
      } while (cursor);
      return { ids, sizes };
    }

    it("lists newest first and returns an empty page for no jobs", async () => {
      expect((await get("/api/jobs")).json()).toEqual({ items: [], nextCursor: null });

      const old = await seedJob({ createdAt: "2026-01-01T00:00:00Z" });
      const recent = await seedJob({ createdAt: "2026-03-01T00:00:00Z" });
      const middle = await seedJob({ createdAt: "2026-02-01T00:00:00Z" });
      const { items, nextCursor } = (await get("/api/jobs")).json();
      expect(items.map((i: { id: string }) => i.id)).toEqual([recent, middle, old]);
      expect(nextCursor).toBeNull();
    });

    it("pages with a cursor, with no gaps or repeats", async () => {
      const ids: string[] = [];
      for (let day = 1; day <= 7; day++) ids.push(await seedJob({ createdAt: `2026-01-0${day}T00:00:00Z` }));
      const expected = ids.reverse();

      const { ids: seen, sizes } = await walk(3);
      expect(seen).toEqual(expected);
      expect(sizes).toEqual([3, 3, 1]);
    });

    it("has no next cursor when the last page is exactly full", async () => {
      for (let day = 1; day <= 4; day++) await seedJob({ createdAt: `2026-01-0${day}T00:00:00Z` });
      const first = (await get("/api/jobs?limit=2")).json();
      const second = (await get(`/api/jobs?limit=2&cursor=${first.nextCursor}`)).json();
      expect(second.items).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
    });

    it("stays correct when rows share a timestamp, or differ only by microseconds", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) ids.push(await seedJob({ createdAt: "2026-01-01T00:00:00Z" })); // identical
      for (let i = 1; i <= 4; i++) ids.push(await seedJob({ createdAt: `2026-01-02T00:00:00.00000${i}Z` })); // same millisecond

      const { ids: seen } = await walk(3);
      expect(seen).toHaveLength(8);
      expect(new Set(seen).size).toBe(8);
      expect(new Set(seen)).toEqual(new Set(ids));
    });

    it("does not skip or repeat rows when new jobs arrive between pages", async () => {
      const ids: string[] = [];
      for (let day = 1; day <= 4; day++) ids.push(await seedJob({ createdAt: `2026-01-0${day}T00:00:00Z` }));
      const first = (await get("/api/jobs?limit=2")).json();
      await seedJob({ createdAt: "2026-06-01T00:00:00Z" }); // newer than everything: lands before the cursor
      const second = (await get(`/api/jobs?limit=2&cursor=${first.nextCursor}`)).json();

      expect([...first.items, ...second.items].map((i: { id: string }) => i.id)).toEqual(ids.reverse());
    });

    it("returns each job in summary form", async () => {
      await seedJob({ url: "https://site.test/x" });
      const [item] = (await get("/api/jobs")).json().items;
      expect(item).toMatchObject({
        url: "https://site.test/x",
        status: "Pending",
        progress: { pagesDiscovered: 1, pagesProcessed: 0 },
        completedAt: null,
      });
    });

    it.each(["limit=0", "limit=101", "limit=abc", "cursor=garbage", "cursor=!!!"])("400s for %s", async (qs) => {
      const res = await get(`/api/jobs?${qs}`);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe("VALIDATION_ERROR");
    });
  });

  describe("GET /api/jobs?status= (server-side filter)", () => {
    const ids = (res: { json: () => any }): string[] => res.json().items.map((i: { id: string }) => i.id);
    const day = (n: number) => `2026-01-0${n}T00:00:00Z`;

    it("returns only jobs in the requested status, newest first", async () => {
      const f1 = await seedJob({ status: "Failed", createdAt: day(1) });
      await seedJob({ status: "Completed", createdAt: day(2) });
      const f2 = await seedJob({ status: "Failed", createdAt: day(3) });
      await seedJob({ status: "Running", createdAt: day(4) });

      const res = await get("/api/jobs?status=Failed");
      expect(res.statusCode).toBe(200);
      expect(ids(res)).toEqual([f2, f1]);
      expect(res.json().nextCursor).toBeNull();
    });

    it("accepts several statuses as a comma list or a repeated parameter", async () => {
      const p = await seedJob({ status: "Pending", createdAt: day(1) });
      const r = await seedJob({ status: "Running", createdAt: day(2) });
      await seedJob({ status: "Completed", createdAt: day(3) });

      expect(ids(await get("/api/jobs?status=Pending,Running"))).toEqual([r, p]);
      expect(ids(await get("/api/jobs?status=Pending&status=Running"))).toEqual([r, p]);
    });

    it("lists everything when there is no filter, or an empty one", async () => {
      await seedJob({ status: "Failed" });
      await seedJob({ status: "Completed" });
      expect(ids(await get("/api/jobs"))).toHaveLength(2);
      expect(ids(await get("/api/jobs?status="))).toHaveLength(2);
    });

    it("returns an empty page, not an error, for a status nobody has", async () => {
      await seedJob({ status: "Completed" });
      expect((await get("/api/jobs?status=Canceled")).json()).toEqual({ items: [], nextCursor: null });
    });

    it("pages within the filter with a cursor, with no gaps, repeats or other statuses", async () => {
      const failed: string[] = [];
      for (let d = 1; d <= 7; d++) {
        await seedJob({ status: d % 2 ? "Failed" : "Completed", createdAt: `2026-01-0${d}T00:00:00Z` });
        if (d % 2) failed.push(await seedJob({ status: "Failed", createdAt: `2026-01-0${d}T12:00:00Z` }));
      }
      const expected = (await rows("SELECT id FROM jobs WHERE status = 'Failed' ORDER BY created_at DESC, id DESC")).map((r) => r.id);

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await get(`/api/jobs?status=Failed&limit=3${cursor ? `&cursor=${cursor}` : ""}`);
        seen.push(...ids(res));
        cursor = res.json().nextCursor;
      } while (cursor);

      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(seen.length);
      expect(failed.length).toBe(4);
    });

    it("stays correct for rows that share a timestamp", async () => {
      for (let i = 0; i < 5; i++) await seedJob({ status: "Failed", createdAt: day(1) });
      await seedJob({ status: "Completed", createdAt: day(1) });
      const first = (await get("/api/jobs?status=Failed&limit=2")).json();
      const second = (await get(`/api/jobs?status=Failed&limit=2&cursor=${first.nextCursor}`)).json();
      const third = (await get(`/api/jobs?status=Failed&limit=2&cursor=${second.nextCursor}`)).json();
      const all = [...first.items, ...second.items, ...third.items].map((i: { id: string }) => i.id);
      expect(all).toHaveLength(5);
      expect(new Set(all).size).toBe(5);
      expect(third.nextCursor).toBeNull();
    });

    it.each(["status=failed", "status=Bogus", "status=Failed,Bogus", "status=%27%3B%20DROP%20TABLE%20jobs%3B--"])("400s for %s", async (qs) => {
      const res = await get(`/api/jobs?${qs}`);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res)).toMatchObject({ code: "VALIDATION_ERROR", details: [{ field: "status", message: expect.stringContaining("Pending") }] });
    });

    it("has an index for it", async () => {
      const [idx] = await rows("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'jobs_status_created_idx'");
      expect(idx.indexdef).toContain("(status, created_at DESC, id DESC)");
    });
  });

  describe("GET /api/jobs/counts", () => {
    it("counts every status, with zeros for the ones nobody has", async () => {
      expect((await get("/api/jobs/counts")).json()).toEqual({
        total: 0,
        byStatus: { Pending: 0, Running: 0, Completed: 0, Failed: 0, Canceled: 0 },
      });

      for (const status of ["Completed", "Completed", "Completed", "Failed", "Running"]) await seedJob({ status });
      expect((await get("/api/jobs/counts")).json()).toEqual({
        total: 5,
        byStatus: { Pending: 0, Running: 1, Completed: 3, Failed: 1, Canceled: 0 },
      });
    });

    it("counts the whole history, not one page of it", async () => {
      for (let i = 0; i < 30; i++) await seedJob({ status: "Completed" });
      expect((await get("/api/jobs?limit=5")).json().items).toHaveLength(5);
      expect((await get("/api/jobs/counts")).json().byStatus.Completed).toBe(30);
    });

    it("is not mistaken for a job id", async () => {
      expect((await get("/api/jobs/counts")).statusCode).toBe(200);
    });
  });

  describe("POST /api/jobs/:id/cancel", () => {
    it.each(["Pending", "Running"])("cancels a %s job and stamps completed_at", async (status) => {
      const id = await seedJob({ status });
      const res = await post(`/api/jobs/${id}/cancel`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id, status: "Canceled", completedAt: expect.any(String) });
      expect((await rows("SELECT status FROM jobs WHERE id = $1", [id]))[0].status).toBe("Canceled");
    });

    it("is idempotent for a job that is already canceled", async () => {
      const id = await seedJob({ status: "Pending" });
      await post(`/api/jobs/${id}/cancel`);
      const again = await post(`/api/jobs/${id}/cancel`);
      expect(again.statusCode).toBe(200);
      expect(again.json().status).toBe("Canceled");
    });

    it.each(["Completed", "Failed"])("409s for a %s job and leaves it alone", async (status) => {
      const id = await seedJob({ status });
      const res = await post(`/api/jobs/${id}/cancel`);
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toMatchObject({ code: "CONFLICT", message: expect.stringContaining(status) });
      expect((await rows("SELECT status FROM jobs WHERE id = $1", [id]))[0].status).toBe(status);
    });

    it("404s for an unknown job and 400s for a bad id", async () => {
      expect((await post("/api/jobs/00000000-0000-0000-0000-000000000000/cancel")).statusCode).toBe(404);
      expect((await post("/api/jobs/nope/cancel")).statusCode).toBe(400);
    });
  });

  describe("GET /health", () => {
    it("is ok when the database and broker are up", async () => {
      const res = await get("/health");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok", database: true, broker: true });
    });

    it("is 503 when the broker is down", async () => {
      broker.healthy = false;
      const res = await get("/health");
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: "unavailable", database: true, broker: false });
    });

    it("is 503 when the database is down", async () => {
      const broken = await buildApp({
        pool: { query: async () => { throw new Error("db down"); } } as never,
        broker,
        outbox,
        corsOrigins: [],
        defaultMaxDepth: 2,
        defaultMaxPages: 200,
      });
      const res = await broken.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: "unavailable", database: false, broker: true });
      await broken.close();
    });
  });

  describe("failStaleJobs", () => {
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const statusOf = async (id: string) => (await rows("SELECT status, failure_reason, completed_at FROM jobs WHERE id = $1", [id]))[0];

    it("fails Pending and Running jobs past the limit, with a reason and a completion time", async () => {
      const pending = await seedJob({ status: "Pending", createdAt: ago(45) });
      const running = await seedJob({ status: "Running", createdAt: ago(31) });

      expect((await failStaleJobs(db.pool, 30)).sort()).toEqual([pending, running].sort());
      for (const id of [pending, running]) {
        const job = await statusOf(id);
        expect(job).toMatchObject({ status: "Failed", failure_reason: "Timed out: the crawl did not finish within 30 minutes" });
        expect(job.completed_at).not.toBeNull();
      }
    });

    it("leaves recent jobs and already-finished jobs alone", async () => {
      const recent = await seedJob({ status: "Running", createdAt: ago(5) });
      const done = await seedJob({ status: "Completed", createdAt: ago(300) });
      const canceled = await seedJob({ status: "Canceled", createdAt: ago(300) });

      expect(await failStaleJobs(db.pool, 30)).toEqual([]);
      expect((await statusOf(recent)).status).toBe("Running");
      expect((await statusOf(done)).status).toBe("Completed");
      expect((await statusOf(canceled)).status).toBe("Canceled");
    });

    it("shows up through the api as a failed job with its reason", async () => {
      const id = await seedJob({ status: "Running", createdAt: ago(60) });
      await failStaleJobs(db.pool, 30);
      expect((await get(`/api/jobs/${id}`)).json()).toMatchObject({ status: "Failed", failureReason: expect.stringContaining("Timed out") });
    });
  });

  describe("cross-cutting", () => {
    it("answers unknown routes with the standard error shape", async () => {
      const res = await get("/api/nope?x=1");
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route GET /api/nope not found", correlationId: expect.any(String) } });
    });

    it("hides the cause of an unexpected error", async () => {
      const broken = await buildApp({
        pool: { query: async () => { throw new Error("secret connection string"); } } as never,
        broker,
        outbox,
        corsOrigins: [],
        defaultMaxDepth: 2,
        defaultMaxPages: 200,
      });
      const res = await broken.inject({ method: "GET", url: "/api/jobs" });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toMatchObject({ code: "INTERNAL_ERROR", message: "Internal server error" });
      expect(res.body).not.toContain("secret");
      await broken.close();
    });

    it("echoes a caller's correlation id, and generates one otherwise", async () => {
      const own = await app.inject({ method: "GET", url: "/health", headers: { "x-correlation-id": "abc-123" } });
      expect(own.headers["x-correlation-id"]).toBe("abc-123");

      const generated = await get("/health");
      expect(generated.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("replaces an unsafe correlation id instead of trusting it", async () => {
      const res = await app.inject({ method: "GET", url: "/health", headers: { "x-correlation-id": "bad id\twith spaces" } });
      expect(res.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("puts the correlation id in error bodies", async () => {
      const res = await app.inject({ method: "GET", url: "/api/jobs/nope", headers: { "x-correlation-id": "trace-me" } });
      expect(errorOf(res).correlationId).toBe("trace-me");
    });

    it("logs every request line with correlationId, and with jobId for job routes", async () => {
      const id = await seedJob();
      await app.inject({ method: "GET", url: `/api/jobs/${id}`, headers: { "x-correlation-id": "log-me" } });

      const lines = logLines.filter((l) => l.correlationId === "log-me");
      expect(lines.map((l) => l.msg)).toEqual(expect.arrayContaining(["incoming request", "request completed"]));
      const completed = lines.find((l) => l.msg === "request completed")!;
      expect(completed).toMatchObject({ jobId: id, correlationId: "log-me" });
      expect((completed.res as { statusCode: number }).statusCode).toBe(200);
    });

    it("carries one correlation id from request to log to published message", async () => {
      const res = await post("/api/jobs", { url: "https://site.test" }, { "x-correlation-id": "end-to-end" });
      const { jobId } = res.json();
      expect((await rows("SELECT payload FROM outbox"))[0].payload.correlationId).toBe("end-to-end");
      expect(logLines.find((l) => l.msg === "job created")).toMatchObject({ correlationId: "end-to-end", jobId });
    });

    describe("CORS", () => {
      it("answers a preflight from the web app origin", async () => {
        const res = await app.inject({
          method: "OPTIONS",
          url: "/api/jobs",
          headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
        });
        expect(res.statusCode).toBe(204);
        expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
        expect(res.headers["access-control-allow-methods"]).toContain("POST");
      });

      it("allows the web origin on real responses and exposes the correlation header", async () => {
        const res = await app.inject({ method: "GET", url: "/health", headers: { origin: ORIGIN } });
        expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
        expect(res.headers["access-control-expose-headers"]).toContain("x-correlation-id");
      });

      it("does not allow other origins", async () => {
        const res = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } });
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      });
    });
  });
});
