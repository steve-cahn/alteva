import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backoffDelay, fetchPage, parseRetryAfter, type FetchOptions } from "../src/fetcher";

const opts: FetchOptions = {
  timeoutMs: 1_000,
  totalTimeoutMs: 10_000,
  maxBodyBytes: 1_000,
  retries: 2,
  baseDelayMs: 5,
  maxRetryAfterMs: 2_000,
  maxRedirects: 5,
};

let server: Server;
let base: string;
const hits: Record<string, number> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    hits[path] = (hits[path] ?? 0) + 1;
    switch (path) {
      case "/ok":
        return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<a href='/x'>x</a>");
      case "/json":
        return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
      case "/no-type":
        return void res.writeHead(200).end("data");
      case "/404":
        return void res.writeHead(404, { "content-type": "text/html" }).end("nope");
      case "/500":
        return void res.writeHead(500).end("boom");
      case "/flaky":
        return void (hits[path] < 3
          ? res.writeHead(503).end()
          : res.writeHead(200, { "content-type": "text/html" }).end("<p>finally</p>"));
      case "/big-declared":
        return void res.writeHead(200, { "content-type": "text/html" }).end("x".repeat(5_000));
      case "/big-streamed":
        res.writeHead(200, { "content-type": "text/html" }); // chunked: no content-length
        res.write("x".repeat(600));
        return void setTimeout(() => res.end("x".repeat(600)), 10);
      case "/reset":
        return void req.socket.destroy();
      case "/slow":
        return; // never responds
      case "/limited":
        return void (hits[path] < 2
          ? res.writeHead(429, { "retry-after": "1" }).end()
          : res.writeHead(200, { "content-type": "text/html" }).end("<p>ok after waiting</p>"));
      case "/limited-long":
        return void res.writeHead(503, { "retry-after": "120" }).end();
      case "/timeout-408":
        return void res.writeHead(408).end();
      case "/redirect":
        return void res.writeHead(302, { location: "/ok" }).end();
      default:
        return void res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("fetchPage", () => {
  it("returns HTML, accepting a charset on the content type", async () => {
    expect(await fetchPage(`${base}/ok`, opts)).toEqual({
      kind: "html",
      httpStatus: 200,
      finalUrl: `${base}/ok`,
      html: "<a href='/x'>x</a>",
    });
  });

  it("skips non-HTML and missing content types without failing", async () => {
    expect(await fetchPage(`${base}/json`, opts)).toMatchObject({ kind: "skipped", httpStatus: 200 });
    expect(await fetchPage(`${base}/no-type`, opts)).toMatchObject({ kind: "skipped" });
  });

  it("fails 4xx immediately without retrying", async () => {
    const result = await fetchPage(`${base}/404`, opts);
    expect(result).toMatchObject({ kind: "failed", httpStatus: 404, retryable: false });
    expect(hits["/404"]).toBe(1);
  });

  it("retries 5xx twice (3 attempts) and then fails", async () => {
    const result = await fetchPage(`${base}/500`, opts);
    expect(result).toMatchObject({ kind: "failed", httpStatus: 500, error: "HTTP 500" });
    expect(hits["/500"]).toBe(3);
  });

  it("recovers when a retry succeeds", async () => {
    expect(await fetchPage(`${base}/flaky`, opts)).toMatchObject({ kind: "html", html: "<p>finally</p>" });
    expect(hits["/flaky"]).toBe(3);
  });

  it("fails without retrying when the declared body is over the limit", async () => {
    const result = await fetchPage(`${base}/big-declared`, opts);
    expect(result).toMatchObject({ kind: "failed", retryable: false });
    expect(hits["/big-declared"]).toBe(1);
  });

  it("fails when a chunked body grows past the limit", async () => {
    expect(await fetchPage(`${base}/big-streamed`, opts)).toMatchObject({ kind: "failed", error: /exceeds 1000/ });
  });

  it("times out on a server that never answers", async () => {
    const result = await fetchPage(`${base}/slow`, { ...opts, timeoutMs: 100, retries: 0 });
    expect(result).toMatchObject({ kind: "failed", httpStatus: null, error: "request timed out" });
  });

  it("treats connection refused as transient", async () => {
    // Grab a free port, then close the listener so nothing is there. (Port 1 would not do:
    // fetch rejects it up front as a restricted "bad port", which is permanent.)
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as { port: number };
    await new Promise((resolve) => probe.close(resolve));

    const result = await fetchPage(`http://127.0.0.1:${port}/`, { ...opts, retries: 0 });
    expect(result).toMatchObject({ kind: "failed", httpStatus: null, retryable: true, error: expect.stringContaining("ECONNREFUSED") });
  });

  it("treats a restricted port as a permanent failure", async () => {
    expect(await fetchPage("http://127.0.0.1:1/", { ...opts, retries: 0 })).toMatchObject({ kind: "failed", retryable: false });
  });

  it("treats a connection reset as transient and retries it", async () => {
    const result = await fetchPage(`${base}/reset`, opts);
    expect(result).toMatchObject({ kind: "failed", httpStatus: null, retryable: true });
    expect(hits["/reset"]).toBe(3);
  });

  it("treats 429 as transient", async () => {
    // Not served by the fixture server (404 would be permanent), so assert via a one-off server.
    const limited = createServer((_req, res) => res.writeHead(429).end());
    await new Promise<void>((resolve) => limited.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(limited.address() as { port: number }).port}/`;
    expect(await fetchPage(url, { ...opts, retries: 0 })).toMatchObject({ kind: "failed", httpStatus: 429, retryable: true });
    limited.close();
  });

  it("treats a malformed URL as a permanent failure without retrying", async () => {
    expect(await fetchPage("not a url", opts)).toMatchObject({ kind: "failed", httpStatus: null, retryable: false });
  });

  it("follows redirects and reports the final URL", async () => {
    expect(await fetchPage(`${base}/redirect`, opts)).toMatchObject({ kind: "html", finalUrl: `${base}/ok` });
  });
});

describe("fetchPage: retry policy", () => {
  it("waits the server's Retry-After before retrying a 429, then succeeds", async () => {
    const started = Date.now();
    const result = await fetchPage(`${base}/limited`, opts);
    expect(result).toMatchObject({ kind: "html", html: "<p>ok after waiting</p>" });
    expect(hits["/limited"]).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950); // Retry-After: 1, not the 5 ms backoff
  });

  it("does not wait out a Retry-After longer than the cap: it reports it for the message retry queue", async () => {
    const started = Date.now();
    const result = await fetchPage(`${base}/limited-long`, opts);
    expect(result).toMatchObject({ kind: "failed", httpStatus: 503, retryable: true, retryAfterMs: 120_000 });
    expect(hits["/limited-long"]).toBe(1); // no in-process retry
    expect(Date.now() - started).toBeLessThan(5_000); // it did not sit out the 120 s Retry-After
  });

  it("treats 408 as transient", async () => {
    expect(await fetchPage(`${base}/timeout-408`, { ...opts, retries: 0 })).toMatchObject({ kind: "failed", httpStatus: 408, retryable: true });
  });

  it("stops retrying when the total time budget is used up, however many retries remain", async () => {
    const before = hits["/500"] ?? 0;
    const started = Date.now();
    const result = await fetchPage(`${base}/500`, { ...opts, retries: 10, baseDelayMs: 100, totalTimeoutMs: 250 });
    // Normally the 500; on a starved machine the first attempt can itself run out of budget and time out.
    // Either way the point holds: it stays retryable, and it stops once the budget is gone.
    expect(result).toMatchObject({ kind: "failed", retryable: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((hits["/500"] ?? 0) - before).toBeLessThan(6); // far fewer than the 11 attempts retries allow
  });
});

describe("backoffDelay", () => {
  it("doubles each retry", () => {
    const noJitter = () => 1 - Number.EPSILON; // top of the jitter range
    expect([1, 2, 3, 4].map((n) => backoffDelay(n, 500, noJitter))).toEqual([500, 1000, 2000, 4000]);
  });

  it("applies jitter between half and the full delay", () => {
    expect(backoffDelay(2, 1000, () => 0)).toBe(1000); // 2000 * 0.5
    expect(backoffDelay(2, 1000, () => 0.999)).toBeLessThanOrEqual(2000);
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const d = backoffDelay(3, 500, () => r);
      expect(d).toBeGreaterThanOrEqual(1000);
      expect(d).toBeLessThanOrEqual(2000);
    }
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");

  it("reads delta-seconds", () => {
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("120")).toBe(120_000);
    expect(parseRetryAfter(" 7 ")).toBe(7_000);
  });

  it("reads an HTTP date relative to now, never negative", () => {
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Wed, 31 Dec 2025 23:00:00 GMT", now)).toBe(0);
  });

  it.each([[null], [""], ["soon"], ["-5"], ["1.5"]])("ignores %j", (value) => {
    expect(parseRetryAfter(value, now)).toBeUndefined();
  });
});

describe("fetchPage: redirects", () => {
  const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } });
  const page = (html = "<a href='/x'>x</a>") => () => new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  /** A fetch that answers from a table of responses and records the URLs it was asked for. */
  function stub(routes: Record<string, () => Response>) {
    const asked: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      const respond = routes[url];
      if (!respond) throw new Error(`unexpected request: ${url}`);
      return respond();
    }) as typeof fetch;
    return { asked, options: { ...opts, retries: 0, fetchFn } };
  }

  it("follows redirects, resolving relative Locations, and reports the final URL", async () => {
    const { asked, options } = stub({
      "https://a.test/start": redirect("/middle", 301),
      "https://a.test/middle": redirect("https://a.test/end", 308),
      "https://a.test/end": page(),
    });
    expect(await fetchPage("https://a.test/start", options)).toMatchObject({ kind: "html", finalUrl: "https://a.test/end" });
    expect(asked).toEqual(["https://a.test/start", "https://a.test/middle", "https://a.test/end"]);
  });

  it("allows a redirect to another host, and an upgrade from http to https", async () => {
    const { options } = stub({ "http://a.test/": redirect("https://www.a.test/home"), "https://www.a.test/home": page() });
    expect(await fetchPage("http://a.test/", options)).toMatchObject({ kind: "html", finalUrl: "https://www.a.test/home" });
  });

  it("follows exactly the maximum number of redirects, and refuses one more", async () => {
    const chain = (n: number) => `https://a.test/${n}`;
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < 5; i++) routes[chain(i)] = redirect(chain(i + 1));
    routes[chain(5)] = page();
    expect(await fetchPage(chain(0), stub(routes).options)).toMatchObject({ kind: "html", finalUrl: chain(5) });

    routes[chain(5)] = redirect(chain(6)); // a sixth redirect
    routes[chain(6)] = page();
    expect(await fetchPage(chain(0), stub(routes).options)).toMatchObject({
      kind: "failed",
      retryable: false,
      error: "too many redirects (more than 5)",
    });
  });

  it("gives up on a redirect loop instead of following it forever", async () => {
    const { asked, options } = stub({ "https://a.test/a": redirect("/b"), "https://a.test/b": redirect("/a") });
    expect(await fetchPage("https://a.test/a", options)).toMatchObject({ kind: "failed", retryable: false, error: expect.stringContaining("too many redirects") });
    expect(asked.length).toBe(6);
  });

  it("refuses a redirect from https down to http, without requesting the http URL", async () => {
    const { asked, options } = stub({ "https://a.test/": redirect("http://a.test/plain") });
    expect(await fetchPage("https://a.test/", options)).toMatchObject({
      kind: "failed",
      retryable: false,
      error: "redirect from https to http refused",
    });
    expect(asked).toEqual(["https://a.test/"]);
  });

  it.each([
    ["to a non-http(s) scheme", "ftp://a.test/file", "redirect to a non-http(s) URL: ftp:"],
    ["to javascript:", "javascript:alert(1)", "redirect to a non-http(s) URL: javascript:"],
    ["to an invalid URL", "http://", "redirect to an invalid URL: http://"],
  ])("refuses a redirect %s", async (_name, location, error) => {
    const { options } = stub({ "https://a.test/": redirect(location) });
    expect(await fetchPage("https://a.test/", options)).toMatchObject({ kind: "failed", retryable: false, error });
  });

  it("refuses a redirect that has no Location", async () => {
    const { options } = stub({ "https://a.test/": () => new Response(null, { status: 302 }) });
    expect(await fetchPage("https://a.test/", options)).toMatchObject({ kind: "failed", retryable: false, error: "HTTP 302 redirect without a Location" });
  });

  it("treats a 5xx after a redirect as transient, like any other", async () => {
    const { options } = stub({ "https://a.test/": redirect("/err"), "https://a.test/err": () => new Response(null, { status: 503 }) });
    expect(await fetchPage("https://a.test/", options)).toMatchObject({ kind: "failed", httpStatus: 503, retryable: true });
  });
});

