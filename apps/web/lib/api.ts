import { API_BASE_URL } from "./config";

export type JobStatus = "Pending" | "Running" | "Completed" | "Failed" | "Canceled";

export interface Job {
  id: string;
  url: string;
  status: JobStatus;
  maxDepth: number;
  maxPages: number;
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  progress: { pagesDiscovered: number; pagesProcessed: number };
  /** Pages by status. Only on a single-job read, not in the history list. */
  pageCounts?: PageCounts;
}

export interface PageCounts {
  queued: number;
  done: number;
  skipped: number;
  failed: number;
}

export interface PageTreeNode {
  id: string;
  url: string;
  depth: number;
  status: "queued" | "done" | "skipped" | "failed";
  domainLinkRatio: number | null;
  outgoingCount: number | null;
  children: PageTreeNode[];
}

export interface JobTreeResponse {
  jobId: string;
  status: JobStatus;
  tree: PageTreeNode | null;
}

export interface PageLink {
  url: string;
  isInternal: boolean;
}

export interface PageLinksResponse {
  pageId: string;
  url: string;
  /** How many links the page has in all; `links` holds at most the first 1000. */
  total: number;
  truncated: boolean;
  links: PageLink[];
}

export interface JobCounts {
  total: number;
  byStatus: Record<JobStatus, number>;
}

export interface JobList {
  items: Job[];
  nextCursor: string | null;
}

export interface FieldError {
  field: string;
  message: string;
}

/** Any failed call: the api's `{ error }` body, or status 0 / NETWORK_ERROR when it was unreachable. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: FieldError[] = [],
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }

  /** The job id was malformed or the job does not exist: retrying will not help. */
  get isNotFound(): boolean {
    return this.status === 404 || (this.status === 400 && this.details.some((d) => d.field === "id"));
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: init.body ? { "content-type": "application/json" } : undefined,
    });
  } catch (err) {
    if (init.signal?.aborted) throw err; // the caller gave up; not an error to display
    throw new ApiRequestError(0, "NETWORK_ERROR", `Could not reach the API at ${API_BASE_URL}. Is it running?`);
  }

  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string; details?: FieldError[]; correlationId?: string } } | null)?.error;
    throw new ApiRequestError(res.status, e?.code ?? "HTTP_ERROR", e?.message ?? `Request failed (${res.status})`, e?.details ?? [], e?.correlationId);
  }
  return body as T;
}

export function createJob(input: { url: string; maxDepth?: number }): Promise<{ jobId: string }> {
  return request("/api/jobs", { method: "POST", body: JSON.stringify(input) });
}

export function getJob(id: string, signal?: AbortSignal): Promise<Job> {
  return request(`/api/jobs/${encodeURIComponent(id)}`, { signal });
}

export function getJobTree(id: string, signal?: AbortSignal): Promise<JobTreeResponse> {
  return request(`/api/jobs/${encodeURIComponent(id)}/tree`, { signal });
}

export function getPageLinks(jobId: string, pageId: string, signal?: AbortSignal): Promise<PageLinksResponse> {
  return request(`/api/jobs/${encodeURIComponent(jobId)}/pages/${encodeURIComponent(pageId)}/links`, { signal });
}

export function cancelJob(id: string): Promise<Job> {
  return request(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

/**
 * One page of history, newest first. `status` filters on the server (one or several statuses), and
 * `cursor` continues a previous page: pass the same `status` with it.
 */
export function listJobs({ cursor, status, signal }: { cursor?: string | null; status?: JobStatus[]; signal?: AbortSignal } = {}): Promise<JobList> {
  const query = new URLSearchParams();
  if (status && status.length > 0) query.set("status", status.join(","));
  if (cursor) query.set("cursor", cursor);
  const qs = query.toString();
  return request(`/api/jobs${qs ? `?${qs}` : ""}`, { signal });
}

/** How many jobs there are in each status over the whole history (not just the loaded page). */
export function getJobCounts(signal?: AbortSignal): Promise<JobCounts> {
  return request("/api/jobs/counts", { signal });
}
