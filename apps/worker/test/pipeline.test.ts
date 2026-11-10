import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import type { PageTaskMessage } from "@alteva/core";
import type { FetchResult } from "../src/fetcher";
import { TransientError } from "../src/errors";
import { failPage, processPage } from "../src/pipeline";
import { createTestDb, postgresAvailable, seedJob, type TestDb } from "./helpers";

const log = pino({ level: "silent" });
const dbUp = await postgresAvailable();

const html = (...hrefs: string[]): FetchResult => ({
  kind: "html",
  httpStatus: 200,
  finalUrl: "",
  html: hrefs.map((h) => `<a href="${h}">x</a>`).join(""),
});

/** Fake fetcher: serves canned results by URL, with the page's own URL as the link base. */
function fakeFetch(pages: Record<string, FetchResult>) {
  return async (url: string): Promise<FetchResult> => {
    const result = pages[url] ?? { kind: "failed", httpStatus: 404, error: "HTTP 404", retryable: false };
    return result.kind === "html" ? { ...result, finalUrl: url } : result;
  };
}

describe.skipIf(!dbUp)("processPage (postgres)", () => {
  let db: TestDb;
  beforeAll(async () => (db = await createTestDb()));
  afterAll(async () => db.close());

  const ROOT = "https://site.test/";
  const task = (jobId: string, url: string, depth = 0, parentPageId: number | null = null): PageTaskMessage => ({
    messageId: "m",
    jobId,
    url,
    depth,
    parentPageId,
    correlationId: "corr-1",
  });
  const run = (pages: Record<string, FetchResult>, msg: PageTaskMessage) =>
    processPage({ pool: db.pool, fetchPage: fakeFetch(pages) }, msg, log);
  const seed = (opts: { maxDepth?: number; maxPages?: number; status?: string } = {}) =>
    seedJob(db.pool, { url: ROOT, startHost: "site.test", ...opts });
  const job = async (id: string) => (await db.pool.query("SELECT * FROM jobs WHERE id = $1", [id])).rows[0];
  const pageRow = async (id: string, url: string) =>
    (await db.pool.query("SELECT * FROM pages WHERE job_id = $1 AND normalized_url = $2", [id, url])).rows[0];
  const outboxFor = async (id: string) =>
    (await db.pool.query("SELECT payload FROM outbox WHERE payload->>'jobId' = $1 ORDER BY id", [id])).rows.map((r) => r.payload);
  const count = async (table: string, id: string) =>
    Number((await db.pool.query(`SELECT count(*) FROM ${table} WHERE job_id = $1`, [id])).rows[0].count);

  it("records the page, its edges and queues only new internal links as children", async () => {
    const { jobId, rootPageId } = await seed();
    const outcome = await run({ [ROOT]: html("/a", "/b#frag", "https://other.test/x", "mailto:x@y.z") }, task(jobId, ROOT));

    expect(outcome.kind).toBe("processed");
    if (outcome.kind !== "processed") return;
    expect(outcome.children.map((c) => c.url)).toEqual(["https://site.test/a", "https://site.test/b"]);
    expect(outcome.children[0]).toMatchObject({ jobId, depth: 1, parentPageId: Number(rootPageId), correlationId: "corr-1" });

    expect(await pageRow(jobId, ROOT)).toMatchObject({
      status: "done",
      http_status: 200,
      outgoing_count: 3,
      internal_count: 2,
      domain_link_ratio: 2 / 3,
    });
    expect(await count("edges", jobId)).toBe(3); // external link is an edge, mailto is not
    expect(await pageRow(jobId, "https://site.test/a")).toMatchObject({ status: "queued", depth: 1 });
    expect(await job(jobId)).toMatchObject({ status: "Running", pages_processed: 1, pages_discovered: 3 });
    expect((await job(jobId)).started_at).not.toBeNull();

    // Their messages were queued in the outbox by the same transaction: exactly the children returned.
    expect(await outboxFor(jobId)).toEqual(outcome.children);
  });

  it("queues no message for a page that has no new children", async () => {
    const { jobId } = await seed();
    await run({ [ROOT]: html("https://other.test/x") }, task(jobId, ROOT));
    expect(await outboxFor(jobId)).toEqual([]);
  });

  it("treats a redelivered message as a no-op", async () => {
    const { jobId } = await seed();
    const pages = { [ROOT]: html("/a", "/b") };
    await run(pages, task(jobId, ROOT));
    const before = await job(jobId);

    const queuedBefore = await outboxFor(jobId);
    expect((await run(pages, task(jobId, ROOT))).kind).toBe("duplicate");
    expect(await outboxFor(jobId)).toEqual(queuedBefore); // a duplicate delivery queues nothing new
    expect(await job(jobId)).toEqual(before);
    expect(await count("pages", jobId)).toBe(3);
    expect(await count("edges", jobId)).toBe(2);
  });

  it("does not re-add links that already exist as pages (cycles, repeats)", async () => {
    const { jobId } = await seed();
    await run({ [ROOT]: html("/a") }, task(jobId, ROOT));
    const outcome = await run({ "https://site.test/a": html("/", "/a", "/a/") }, task(jobId, "https://site.test/a", 1, 1));

    expect(outcome).toMatchObject({ kind: "processed", children: [] });
    expect(await count("pages", jobId)).toBe(2);
    expect(await job(jobId)).toMatchObject({ pages_processed: 2, pages_discovered: 2, status: "Completed" });
  });

  it("records edges but creates no children at max depth", async () => {
    const { jobId } = await seed({ maxDepth: 1 });
    await run({ [ROOT]: html("/a") }, task(jobId, ROOT));
    const leaf = await run({ "https://site.test/a": html("/c", "/d") }, task(jobId, "https://site.test/a", 1, 1));

    expect(leaf).toMatchObject({ kind: "processed", children: [] });
    expect(await count("pages", jobId)).toBe(2);
    expect(await count("edges", jobId)).toBe(3);
  });

  it("at max depth 0 crawls only the start page, but still records all of its links", async () => {
    const { jobId } = await seed({ maxDepth: 0 });
    const outcome = await run({ [ROOT]: html("/a", "/b", "https://other.test/x") }, task(jobId, ROOT));

    expect(outcome).toMatchObject({ kind: "processed", children: [], jobStatus: "Completed" });
    expect(await count("pages", jobId)).toBe(1);
    expect(await count("edges", jobId)).toBe(3);
    expect(await pageRow(jobId, ROOT)).toMatchObject({ status: "done", outgoing_count: 3, internal_count: 2, domain_link_ratio: 2 / 3 });
    expect(await outboxFor(jobId)).toEqual([]); // nothing further to crawl, so nothing queued
    expect(await job(jobId)).toMatchObject({ status: "Completed", pages_discovered: 1, pages_processed: 1 });
  });

  it("caps discovered pages at max_pages", async () => {
    const { jobId } = await seed({ maxPages: 3 });
    const outcome = await run({ [ROOT]: html("/a", "/b", "/c", "/d", "/e") }, task(jobId, ROOT));

    expect(outcome).toMatchObject({ kind: "processed" });
    expect(await count("pages", jobId)).toBe(3);
    expect(await job(jobId)).toMatchObject({ pages_discovered: 3 });
    expect(await count("edges", jobId)).toBe(5); // edges are still all recorded
    expect(await outboxFor(jobId)).toHaveLength(2); // one message per page actually created
  });

  it("never exceeds max_pages when workers race on the same job", async () => {
    const { jobId } = await seed({ maxPages: 6 });
    // Fan out to /a and /b first, then process both concurrently, each with 4 distinct new links.
    await run({ [ROOT]: html("/a", "/b") }, task(jobId, ROOT));
    const pages = {
      "https://site.test/a": html("/a1", "/a2", "/a3", "/a4"),
      "https://site.test/b": html("/b1", "/b2", "/b3", "/b4"),
    };
    await Promise.all([
      run(pages, task(jobId, "https://site.test/a", 1, 1)),
      run(pages, task(jobId, "https://site.test/b", 1, 1)),
    ]);

    expect(await count("pages", jobId)).toBe(6);
    expect(await job(jobId)).toMatchObject({ pages_discovered: 6, pages_processed: 3 });
  });

  it("marks non-HTML pages skipped, with no edges, and still counts them as processed", async () => {
    const { jobId } = await seed();
    await run({ [ROOT]: html("/doc.pdf") }, task(jobId, ROOT));
    await run(
      { "https://site.test/doc.pdf": { kind: "skipped", httpStatus: 200, reason: "non-HTML content type: application/pdf" } },
      task(jobId, "https://site.test/doc.pdf", 1, 1),
    );

    expect(await pageRow(jobId, "https://site.test/doc.pdf")).toMatchObject({
      status: "skipped",
      http_status: 200,
      error: "non-HTML content type: application/pdf",
      domain_link_ratio: null,
    });
    expect(await job(jobId)).toMatchObject({ status: "Completed", pages_processed: 2 });
  });

  it("marks fetch failures as failed and the job still completes", async () => {
    const { jobId } = await seed();
    await run({ [ROOT]: html("/gone") }, task(jobId, ROOT));
    await run({}, task(jobId, "https://site.test/gone", 1, 1));

    expect(await pageRow(jobId, "https://site.test/gone")).toMatchObject({ status: "failed", http_status: 404, error: "HTTP 404" });
    expect(await job(jobId)).toMatchObject({ status: "Completed" });
  });

  it("throws TransientError on a retryable fetch failure and changes nothing", async () => {
    const { jobId } = await seed();
    const flaky: FetchResult = { kind: "failed", httpStatus: 503, error: "HTTP 503", retryable: true };

    await expect(run({ [ROOT]: flaky }, task(jobId, ROOT))).rejects.toMatchObject({
      name: "TransientError",
      httpStatus: 503,
      message: "HTTP 503",
    });
    expect(await pageRow(jobId, ROOT)).toMatchObject({ status: "queued", processed_at: null });
    expect(await job(jobId)).toMatchObject({ status: "Pending", pages_processed: 0 });
  });

  it("records a permanent failure on the page instead of throwing", async () => {
    const { jobId } = await seed();
    const gone: FetchResult = { kind: "failed", httpStatus: 410, error: "HTTP 410", retryable: false };
    expect(await run({ [ROOT]: gone }, task(jobId, ROOT))).toMatchObject({ kind: "processed" });
    expect(await pageRow(jobId, ROOT)).toMatchObject({ status: "failed", http_status: 410 });
  });

  describe("failPage (retries exhausted)", () => {
    const give = (jobId: string, url: string, depth = 0) =>
      failPage({ pool: db.pool, fetchPage: fakeFetch({}) }, task(jobId, url, depth), { httpStatus: 503, message: "HTTP 503" }, log);

    it("marks the page failed and counts it as processed", async () => {
      const { jobId } = await seed();
      await run({ [ROOT]: html("/a") }, task(jobId, ROOT));
      expect(await give(jobId, "https://site.test/a", 1)).toMatchObject({ kind: "processed", children: [] });
      expect(await pageRow(jobId, "https://site.test/a")).toMatchObject({ status: "failed", http_status: 503, error: "HTTP 503" });
      expect(await job(jobId)).toMatchObject({ status: "Completed", pages_processed: 2, pages_discovered: 2 });
    });

    it("fails the whole job when it is the start page that was given up on", async () => {
      const { jobId } = await seed();
      expect(await give(jobId, ROOT)).toMatchObject({ kind: "processed", jobStatus: "Failed" });
      expect(await job(jobId)).toMatchObject({
        status: "Failed",
        failure_reason: "Could not fetch the start page: HTTP 503",
        pages_processed: 1,
      });
    });

    it("lets the rest of the job finish around a page that was given up on", async () => {
      const { jobId } = await seed();
      await run({ [ROOT]: html("/a", "/b") }, task(jobId, ROOT));
      await give(jobId, "https://site.test/a", 1);
      expect((await job(jobId)).status).toBe("Running");
      await run({ "https://site.test/b": html() }, task(jobId, "https://site.test/b", 1, 1));
      expect(await job(jobId)).toMatchObject({ status: "Completed", pages_processed: 3, pages_discovered: 3 });
    });

    it("is a no-op when the page was already processed", async () => {
      const { jobId } = await seed();
      await run({ [ROOT]: html() }, task(jobId, ROOT));
      expect((await give(jobId, ROOT)).kind).toBe("ignored"); // job already Completed
      expect(await pageRow(jobId, ROOT)).toMatchObject({ status: "done" });
    });
  });

  describe("a start page that cannot be crawled fails the job", () => {
    it.each([
      ["a 404", { kind: "failed", httpStatus: 404, error: "HTTP 404", retryable: false } as FetchResult, "Could not fetch the start page: HTTP 404"],
      ["a 410", { kind: "failed", httpStatus: 410, error: "HTTP 410", retryable: false } as FetchResult, "Could not fetch the start page: HTTP 410"],
      [
        "a non-HTML document",
        { kind: "skipped", httpStatus: 200, reason: "non-HTML content type: application/pdf" } as FetchResult,
        "The start page cannot be crawled: non-HTML content type: application/pdf",
      ],
    ])("%s", async (_name, fetched, reason) => {
      const { jobId } = await seed();
      expect(await run({ [ROOT]: fetched }, task(jobId, ROOT))).toMatchObject({ kind: "processed", jobStatus: "Failed" });

      const row = await job(jobId);
      expect(row).toMatchObject({ status: "Failed", failure_reason: reason, pages_processed: 1 });
      expect(row.started_at).not.toBeNull();
      expect(row.completed_at).not.toBeNull();
    });

    it("but a broken link deeper in the site does not", async () => {
      const { jobId } = await seed();
      await run({ [ROOT]: html("/gone") }, task(jobId, ROOT));
      await run({}, task(jobId, "https://site.test/gone", 1, 1));
      expect(await job(jobId)).toMatchObject({ status: "Completed", failure_reason: null });
    });

    it("and the worker then ignores the job's remaining messages", async () => {
      const { jobId } = await seed();
      await run({}, task(jobId, ROOT));
      expect(await run({ [ROOT]: html("/a") }, task(jobId, "https://site.test/a", 1, 1))).toMatchObject({ kind: "ignored" });
    });
  });

  describe("outgoing links", () => {
    it("does not count a page's links to itself, so an in-page anchor cannot inflate the ratio", async () => {
      const { jobId } = await seed();
      await run({ [ROOT]: html("#top", "/#footer", "/", "/a", "https://other.test/x") }, task(jobId, ROOT));

      expect(await pageRow(jobId, ROOT)).toMatchObject({ outgoing_count: 2, internal_count: 1, domain_link_ratio: 0.5 });
      expect(await count("edges", jobId)).toBe(2);
    });

    it("treats http, https and www spellings of one page as one link, one edge and one child", async () => {
      const { jobId } = await seed();
      const outcome = await run(
        { [ROOT]: html("/a", "http://site.test/a", "https://www.site.test/a", "http://www.site.test/a/") },
        task(jobId, ROOT),
      );

      expect(outcome).toMatchObject({ kind: "processed" });
      if (outcome.kind === "processed") expect(outcome.children.map((c) => c.url)).toEqual(["https://site.test/a"]);
      expect(await count("pages", jobId)).toBe(2);
      expect(await count("edges", jobId)).toBe(1);
      expect(await pageRow(jobId, ROOT)).toMatchObject({ outgoing_count: 1, domain_link_ratio: 1 });
    });
  });

  describe("a page that lands on http after a same-host redirect (a proxy with a wrong-scheme trailing-slash redirect)", () => {
    it("is crawled normally: its links are still the site's own, and it is stored under the address that was requested", async () => {
      const { jobId } = await seed();
      await run({ [ROOT]: html("/tag/love", "/tag/life") }, task(jobId, ROOT));

      // /tag/love 308s to http://site.test/tag/love/ ; its links resolve against THAT address.
      const landedOnHttp: FetchResult = {
        kind: "html",
        httpStatus: 200,
        finalUrl: "http://site.test/tag/love/",
        html: '<a href="/tag/life/">life</a><a href="/tag/love/page/1/">more</a><a href="/tag/love/">itself</a><a href="https://other.test/x">out</a>',
      };
      const outcome = await processPage({ pool: db.pool, fetchPage: async () => landedOnHttp }, task(jobId, "https://site.test/tag/love", 1, 1), log);

      expect(outcome).toMatchObject({ kind: "processed" });
      if (outcome.kind === "processed") {
        // /tag/life already exists, itself is not a link, so only the new page is queued, as https.
        expect(outcome.children.map((c) => c.url)).toEqual(["https://site.test/tag/love/page/1"]);
      }
      expect(await pageRow(jobId, "https://site.test/tag/love")).toMatchObject({ status: "done", outgoing_count: 3, internal_count: 2 });
      expect(await count("pages", jobId)).toBe(4); // root, /tag/love, /tag/life, /tag/love/page/1: never an http twin
    });
  });

  describe("a start page that redirects", () => {
    const redirectingTo = (finalUrl: string, ...hrefs: string[]) => async (): Promise<FetchResult> => ({
      kind: "html",
      httpStatus: 200,
      finalUrl,
      html: hrefs.map((h) => `<a href="${h}">x</a>`).join(""),
    });
    const startProcess = (jobId: string, fetchPage: () => Promise<FetchResult>) =>
      processPage({ pool: db.pool, fetchPage }, task(jobId, ROOT), log);

    it("adopts the final origin: http to https and www, so internal links stay internal", async () => {
      const { jobId } = await seedJob(db.pool, { url: "http://site.test/", startHost: "site.test" });
      const outcome = await processPage(
        { pool: db.pool, fetchPage: redirectingTo("https://www.site.test/home", "/a", "http://site.test/b", "https://other.test/x") },
        task(jobId, "http://site.test/"),
        log,
      );

      expect(outcome).toMatchObject({ kind: "processed" });
      if (outcome.kind === "processed") {
        expect(outcome.children.map((c) => c.url)).toEqual(["https://www.site.test/a", "https://www.site.test/b"]);
      }
      expect(await job(jobId)).toMatchObject({ site_origin: "https://www.site.test", start_host: "www.site.test" });
      expect(await pageRow(jobId, "https://www.site.test/home")).toMatchObject({ depth: 0, status: "done", domain_link_ratio: 2 / 3 });
    });

    it("does not add the start page a second time when a page links back to its final address", async () => {
      const { jobId } = await seedJob(db.pool, { url: "http://site.test/", startHost: "site.test" });
      await processPage({ pool: db.pool, fetchPage: redirectingTo("https://site.test/", "/a") }, task(jobId, "http://site.test/"), log);
      const child = await processPage(
        { pool: db.pool, fetchPage: redirectingTo("https://site.test/a", "https://site.test/", "http://site.test/") },
        task(jobId, "https://site.test/a", 1, 1),
        log,
      );

      expect(child).toMatchObject({ kind: "processed", children: [] });
      expect(await count("pages", jobId)).toBe(2);
      expect(await job(jobId)).toMatchObject({ status: "Completed", pages_processed: 2, pages_discovered: 2 });
    });

    it("follows a move to another domain: the new domain becomes the site", async () => {
      const { jobId } = await seedJob(db.pool, { url: "https://old.test/", startHost: "old.test" });
      const outcome = await processPage(
        { pool: db.pool, fetchPage: redirectingTo("https://new.test/", "/a", "/b", "https://elsewhere.test/") },
        task(jobId, "https://old.test/"),
        log,
      );

      expect(outcome).toMatchObject({ kind: "processed" });
      if (outcome.kind === "processed") expect(outcome.children.map((c) => c.url)).toEqual(["https://new.test/a", "https://new.test/b"]);
      expect(await job(jobId)).toMatchObject({ site_origin: "https://new.test", start_host: "new.test", pages_discovered: 3 });
      expect(await pageRow(jobId, "https://new.test/")).toMatchObject({ domain_link_ratio: 2 / 3 });
    });

    it("keeps the requested address when nothing redirected", async () => {
      const { jobId } = await seed();
      await startProcess(jobId, redirectingTo(ROOT, "/a"));
      expect(await pageRow(jobId, ROOT)).toMatchObject({ status: "done" });
      expect(await job(jobId)).toMatchObject({ site_origin: "https://site.test" });
    });
  });

  it("completes a single-page job on its first message", async () => {
    const { jobId } = await seed();
    await run({ [ROOT]: html() }, task(jobId, ROOT));

    const row = await job(jobId);
    expect(row).toMatchObject({ status: "Completed", pages_processed: 1, pages_discovered: 1 });
    expect(row.started_at).not.toBeNull();
    expect(row.completed_at).not.toBeNull();
    expect((await pageRow(jobId, ROOT)).domain_link_ratio).toBe(0);
  });

  it("keeps the original started_at across messages", async () => {
    const { jobId } = await seed();
    await run({ [ROOT]: html("/a", "/b") }, task(jobId, ROOT));
    const started = (await job(jobId)).started_at;
    await run({ "https://site.test/a": html() }, task(jobId, "https://site.test/a", 1, 1));
    expect((await job(jobId)).started_at).toEqual(started);
  });

  it("ignores messages for canceled jobs and unknown jobs", async () => {
    const { jobId } = await seed({ status: "Canceled" });
    expect(await run({ [ROOT]: html("/a") }, task(jobId, ROOT))).toMatchObject({ kind: "ignored" });
    expect(await count("pages", jobId)).toBe(1);

    const unknown = "00000000-0000-0000-0000-000000000000";
    expect(await run({}, task(unknown, ROOT))).toMatchObject({ kind: "ignored", reason: "job not found" });
  });

  it("skips the fetch entirely for a canceled job", async () => {
    const { jobId } = await seed({ status: "Canceled" });
    let fetches = 0;
    const outcome = await processPage(
      { pool: db.pool, fetchPage: async () => (fetches++, html("/a")) },
      task(jobId, ROOT),
      log,
    );
    expect(outcome).toMatchObject({ kind: "ignored", reason: "job is Canceled" });
    expect(fetches).toBe(0);
  });

  it("stops processing a job canceled while its messages are queued", async () => {
    const { jobId } = await seed();
    await run({ [ROOT]: html("/a", "/b") }, task(jobId, ROOT));
    await db.pool.query("UPDATE jobs SET status = 'Canceled', completed_at = now() WHERE id = $1", [jobId]);

    const outcome = await run({ "https://site.test/a": html("/c") }, task(jobId, "https://site.test/a", 1, 1));
    expect(outcome).toMatchObject({ kind: "ignored" });
    expect(await pageRow(jobId, "https://site.test/a")).toMatchObject({ status: "queued" });
    expect(await job(jobId)).toMatchObject({ status: "Canceled", pages_processed: 1 });
  });

  it("rolls back everything when the transaction fails midway", async () => {
    const { jobId } = await seed();
    const broken = { pool: db.pool, fetchPage: async () => html("/a") };
    // Make the final progress update fail by dropping a column privilege-free: rename temporarily.
    await db.pool.query("ALTER TABLE jobs RENAME COLUMN pages_processed TO pages_processed_x");
    try {
      await expect(processPage(broken, task(jobId, ROOT), log)).rejects.toThrow();
    } finally {
      await db.pool.query("ALTER TABLE jobs RENAME COLUMN pages_processed_x TO pages_processed");
    }
    expect(await pageRow(jobId, ROOT)).toMatchObject({ status: "queued" });
    expect(await count("edges", jobId)).toBe(0);
    expect(await count("pages", jobId)).toBe(1);
    expect(await outboxFor(jobId)).toEqual([]); // no state, no message: they commit together or not at all
  });
});
