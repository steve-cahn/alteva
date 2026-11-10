import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, cancelJob, createJob, getJob, getJobCounts, getPageLinks, listJobs } from "./api";

const BASE = "http://localhost:4000";

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => impl(url, init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("api client", () => {
  it("POSTs a job as JSON and returns the id", async () => {
    const fetchMock = mockFetch(() => json(201, { jobId: "abc" }));

    expect(await createJob({ url: "https://a.com", maxDepth: 3 })).toEqual({ jobId: "abc" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/jobs`);
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ url: "https://a.com", maxDepth: 3 }) });
    expect(init?.headers).toEqual({ "content-type": "application/json" });
  });

  it("sends no content-type on bodyless requests, so reads stay simple CORS requests", async () => {
    const fetchMock = mockFetch(() => json(200, {}));
    await getJob("j1");
    await cancelJob("j1");
    expect(fetchMock.mock.calls[0][1]?.headers).toBeUndefined();
    expect(fetchMock.mock.calls[1][1]?.headers).toBeUndefined();
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/api/jobs/j1/cancel`);
  });

  it("passes the cursor through, url-encoded, and omits it for the first page", async () => {
    const fetchMock = mockFetch(() => json(200, { items: [], nextCursor: null }));
    await listJobs();
    await listJobs({ cursor: "a+b/c=" });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/jobs`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/api/jobs?cursor=a%2Bb%2Fc%3D`);
  });

  it("filters by status on the server, sending several as a comma list", async () => {
    const fetchMock = mockFetch(() => json(200, { items: [], nextCursor: null }));
    await listJobs({ status: ["Failed"] });
    await listJobs({ status: ["Pending", "Running"] });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/jobs?status=Failed`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/api/jobs?status=Pending%2CRunning`);
  });

  it("sends the status again together with the cursor, and sends no filter for an empty list", async () => {
    const fetchMock = mockFetch(() => json(200, { items: [], nextCursor: null }));
    await listJobs({ status: ["Failed"], cursor: "c1" });
    await listJobs({ status: [] });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/jobs?status=Failed&cursor=c1`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/api/jobs`);
  });

  it("reads the counts by status", async () => {
    const fetchMock = mockFetch(() => json(200, { total: 3, byStatus: { Pending: 0, Running: 0, Completed: 3, Failed: 0, Canceled: 0 } }));
    expect(await getJobCounts()).toMatchObject({ total: 3 });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/jobs/counts`);
  });

  it("turns the api's error body into an ApiRequestError with details and reference", async () => {
    mockFetch(() =>
      json(400, {
        error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: [{ field: "url", message: "is required" }], correlationId: "ref-1" },
      }),
    );
    const err = await createJob({ url: "" }).catch((e) => e);

    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      details: [{ field: "url", message: "is required" }],
      correlationId: "ref-1",
    });
  });

  it("reports an unreachable api as NETWORK_ERROR with a helpful message", async () => {
    mockFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const err = await getJob("j1").catch((e) => e);
    expect(err).toMatchObject({ status: 0, code: "NETWORK_ERROR", message: expect.stringContaining(BASE) });
  });

  it("copes with an error response that is not the api's JSON", async () => {
    mockFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    const err = await getJob("j1").catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: "HTTP_ERROR", message: "Request failed (502)" });
  });

  it("rethrows an abort untouched instead of calling it a network error", async () => {
    const controller = new AbortController();
    mockFetch(() => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const err = await getJob("j1", controller.signal).catch((e) => e);
    expect(err).not.toBeInstanceOf(ApiRequestError);
    expect(err.name).toBe("AbortError");
  });

  it("reads a page's links from the job's page-links path", async () => {
    const fetchMock = mockFetch(() => json(200, { pageId: "7", url: "https://a.com/", total: 0, truncated: false, links: [] }));
    expect(await getPageLinks("job-1", "7")).toMatchObject({ pageId: "7", links: [] });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/jobs/job-1/pages/7/links`);
    await getPageLinks("a/b", "1/2");
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/api/jobs/a%2Fb/pages/1%2F2/links`);
  });

  it("encodes the job id into the path", async () => {
    const fetchMock = mockFetch(() => json(200, {}));
    await getJob("a/b");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/jobs/a%2Fb`);
  });
});

describe("ApiRequestError.isNotFound", () => {
  it("is true for 404 and for a malformed job id, false for everything else", () => {
    expect(new ApiRequestError(404, "NOT_FOUND", "x").isNotFound).toBe(true);
    expect(new ApiRequestError(400, "VALIDATION_ERROR", "x", [{ field: "id", message: "must be a UUID" }]).isNotFound).toBe(true);
    expect(new ApiRequestError(400, "VALIDATION_ERROR", "x", [{ field: "url", message: "bad" }]).isNotFound).toBe(false);
    expect(new ApiRequestError(503, "SERVICE_UNAVAILABLE", "x").isNotFound).toBe(false);
    expect(new ApiRequestError(0, "NETWORK_ERROR", "x").isNotFound).toBe(false);
  });
});
