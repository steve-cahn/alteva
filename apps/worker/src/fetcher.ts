import { errorCode, isTransientNetworkError } from "./errors";

export interface FetchOptions {
  /** One attempt, including its redirects and reading the body. */
  timeoutMs: number;
  /** All attempts together, including the waits between them. */
  totalTimeoutMs: number;
  maxBodyBytes: number;
  /** Extra attempts after the first, for transient failures only. */
  retries: number;
  /** First backoff delay; doubles each retry, with jitter. */
  baseDelayMs: number;
  /** A longer Retry-After than this is not waited out here: the message retry queue takes over. */
  maxRetryAfterMs: number;
  maxRedirects: number;
  /** Source of jitter in [0, 1). Replaceable for tests. */
  random?: () => number;
  /** The fetch to use. Replaceable for tests. */
  fetchFn?: typeof fetch;
}

export const DEFAULT_FETCH_OPTIONS: FetchOptions = {
  timeoutMs: 10_000,
  totalTimeoutMs: 45_000,
  maxBodyBytes: 2 * 1024 * 1024,
  retries: 2,
  baseDelayMs: 500,
  maxRetryAfterMs: 10_000,
  maxRedirects: 5,
};

export type FetchResult =
  | { kind: "html"; httpStatus: number; finalUrl: string; html: string }
  | { kind: "skipped"; httpStatus: number; reason: string }
  | { kind: "failed"; httpStatus: number | null; error: string; retryable: boolean; retryAfterMs?: number };

/**
 * Fetches a page. Never throws: every outcome is a result the pipeline records against the page.
 *
 * Transient failures (timeout, reset, DNS, 5xx, 429) are retried here up to `retries` times, waiting
 * the server's `Retry-After` when it gives one and an exponential backoff with jitter otherwise, all
 * within `totalTimeoutMs`. What is still transient after that is returned as retryable, and the
 * caller hands it to the message retry queue.
 */
export async function fetchPage(url: string, options: FetchOptions = DEFAULT_FETCH_OPTIONS): Promise<FetchResult> {
  const deadline = Date.now() + options.totalTimeoutMs;
  let result = await fetchOnce(url, options, deadline);
  for (let retry = 1; retry <= options.retries && isRetryable(result); retry++) {
    const wait = delayBeforeRetry(result, retry, options);
    if (wait === null || Date.now() + wait >= deadline) break;
    await sleep(wait);
    result = await fetchOnce(url, options, deadline);
  }
  return result;
}

function isRetryable(result: FetchResult): boolean {
  return result.kind === "failed" && result.retryable;
}

/** How long to wait before retry number `retry` (1-based), or null to stop retrying in-process. */
function delayBeforeRetry(result: FetchResult, retry: number, options: FetchOptions): number | null {
  if (result.kind === "failed" && result.retryAfterMs !== undefined) {
    return result.retryAfterMs <= options.maxRetryAfterMs ? result.retryAfterMs : null;
  }
  return backoffDelay(retry, options.baseDelayMs, options.random ?? Math.random);
}

/** Exponential backoff with jitter: base * 2^(retry-1), scaled by a random factor in [0.5, 1). */
export function backoffDelay(retry: number, baseDelayMs: number, random: () => number): number {
  return Math.round(baseDelayMs * 2 ** (retry - 1) * (0.5 + random() * 0.5));
}

/** Parses a Retry-After header, in seconds or as an HTTP date, to milliseconds. Undefined when absent or unusable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // Only an HTTP date (it has day and month names) is a date here. Date.parse is lenient enough to
  // read "1.5" or "-5" as some past date, which would turn garbage into "retry immediately".
  if (!/[A-Za-z]{3}/.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchOnce(url: string, options: FetchOptions, deadline: number): Promise<FetchResult> {
  const budget = Math.max(1, Math.min(options.timeoutMs, deadline - Date.now()));
  try {
    return await followRedirects(url, options, AbortSignal.timeout(budget));
  } catch (err) {
    // Timeout, reset, refused or DNS failure is transient; TLS, malformed URL and the like is not.
    return { kind: "failed", httpStatus: null, error: describeError(err), retryable: isTransientNetworkError(err) };
  }
}

/**
 * Follows redirects by hand so each hop can be checked: at most `maxRedirects`, only to http(s), and
 * never from https down to http (which would expose the request to anyone on the path).
 */
async function followRedirects(startUrl: string, options: FetchOptions, signal: AbortSignal): Promise<FetchResult> {
  const doFetch = options.fetchFn ?? fetch;
  let current = startUrl;
  for (let hops = 0; ; hops++) {
    const res = await doFetch(current, {
      redirect: "manual",
      signal,
      headers: { accept: "text/html", "user-agent": "alteva-crawler/0.1" },
    });
    if (!REDIRECT_STATUSES.has(res.status)) return readResponse(res, current, options.maxBodyBytes);

    await res.body?.cancel();
    const location = res.headers.get("location");
    if (!location) return permanentFailure(res.status, `HTTP ${res.status} redirect without a Location`);
    if (hops >= options.maxRedirects) return permanentFailure(res.status, `too many redirects (more than ${options.maxRedirects})`);

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return permanentFailure(res.status, `redirect to an invalid URL: ${location}`);
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      return permanentFailure(res.status, `redirect to a non-http(s) URL: ${next.protocol}`);
    }
    if (new URL(current).protocol === "https:" && next.protocol === "http:") {
      return permanentFailure(res.status, "redirect from https to http refused");
    }
    current = next.href;
  }
}

function permanentFailure(httpStatus: number, error: string): FetchResult {
  return { kind: "failed", httpStatus, error, retryable: false };
}

async function readResponse(res: Response, finalUrl: string, maxBodyBytes: number): Promise<FetchResult> {
  if (res.status >= 400) {
    await res.body?.cancel();
    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    const retryAfterMs = retryable ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
    return {
      kind: "failed",
      httpStatus: res.status,
      error: `HTTP ${res.status}`,
      retryable,
      ...(retryAfterMs !== undefined && { retryAfterMs }),
    };
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!/^text\/html\b/i.test(contentType)) {
    await res.body?.cancel();
    return { kind: "skipped", httpStatus: res.status, reason: `non-HTML content type: ${contentType || "none"}` };
  }
  const html = await readCapped(res, maxBodyBytes);
  if (html === null) return permanentFailure(res.status, `body exceeds ${maxBodyBytes} bytes`);
  return { kind: "html", httpStatus: res.status, finalUrl, html };
}

/** Reads the body as UTF-8 text, or returns null as soon as it exceeds `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > maxBytes) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return "request timed out";
    const code = errorCode(err);
    return code ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
