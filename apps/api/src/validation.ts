import { normalizeUrl } from "@alteva/core";
import { validationError, type FieldError } from "./errors";

/** 0 crawls only the start page (its links are listed, not followed). */
export const MIN_DEPTH = 0;
export const MAX_URL_LENGTH = 2048;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateJobInput {
  /** Normalized absolute http(s) URL. */
  url: string;
  startHost: string;
  maxDepth: number;
}

/**
 * Validates the POST /api/jobs body. Collects every problem rather than stopping at the first.
 *
 * `maxDepth` has no arbitrary limit: any whole number from 0 up to `maxPages`. A crawl can never
 * reach more pages than the page limit, so a depth beyond it could not change the result, which
 * makes it the one ceiling with a reason (and it keeps the value inside the database's integer).
 */
export function parseCreateJob(body: unknown, defaultMaxDepth: number, maxPages: number): CreateJobInput {
  const errors: FieldError[] = [];
  const input = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (input !== body) errors.push({ field: "body", message: "must be a JSON object" });

  const url = parseUrl(input.url, errors);
  const maxDepth = parseMaxDepth(input.maxDepth, defaultMaxDepth, maxPages, errors);
  if (errors.length > 0 || url === null) throw validationError(errors);
  return { url, startHost: new URL(url).hostname, maxDepth };
}

function parseUrl(value: unknown, errors: FieldError[]): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push({ field: "url", message: "is required and must be a string" });
    return null;
  }
  if (value.length > MAX_URL_LENGTH) {
    errors.push({ field: "url", message: `must be at most ${MAX_URL_LENGTH} characters` });
    return null;
  }
  const normalized = normalizeUrl(value);
  if (normalized === null) {
    errors.push({ field: "url", message: "must be an absolute http or https URL" });
    return null;
  }
  return normalized;
}

function parseMaxDepth(value: unknown, fallback: number, ceiling: number, errors: FieldError[]): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_DEPTH || value > ceiling) {
    errors.push({ field: "maxDepth", message: `must be a whole number from ${MIN_DEPTH} to ${ceiling}` });
    return fallback;
  }
  return value;
}

export function parseJobId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw validationError([{ field: "id", message: "must be a UUID" }]);
  }
  return value.toLowerCase();
}

/** A page id is a bigint in the database: digits only, so nothing odd reaches the query. */
export function parsePageId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,17}$/.test(value)) {
    throw validationError([{ field: "pageId", message: "must be a positive whole number" }]);
  }
  return value;
}

export const JOB_STATUSES = ["Pending", "Running", "Completed", "Failed", "Canceled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface ListQuery {
  limit: number;
  cursor: Cursor | null;
  /** Only jobs in one of these statuses; null means every status. */
  statuses: JobStatus[] | null;
}

/** Position in the (created_at DESC, id DESC) ordering. `createdAt` is Postgres text, to keep microseconds. */
export interface Cursor {
  createdAt: string;
  id: string;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString("base64url");
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [createdAt, id] = parsed;
    if (typeof createdAt !== "string" || !TIMESTAMP.test(createdAt)) return null;
    if (typeof id !== "string" || !UUID.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * `status=Failed`, `status=Pending,Running` and `status=Pending&status=Running` all work. Empty means
 * no filter. Names are exact (as the API returns them); anything else is a 400, not silently ignored.
 */
function parseStatuses(value: unknown, errors: FieldError[]): JobStatus[] | null {
  if (value === undefined) return null;
  const parts = (Array.isArray(value) ? value : [value]).flatMap((v) => (typeof v === "string" ? v.split(",") : [v])).map((v) => (typeof v === "string" ? v.trim() : v)).filter((v) => v !== "");
  if (parts.length === 0) return null;
  const unknown = parts.filter((p) => !(JOB_STATUSES as readonly unknown[]).includes(p));
  if (unknown.length > 0) {
    errors.push({ field: "status", message: `must be one or more of ${JOB_STATUSES.join(", ")}` });
    return null;
  }
  return [...new Set(parts as JobStatus[])];
}

export function parseListQuery(query: unknown): ListQuery {
  const q = (query ?? {}) as Record<string, unknown>;
  const errors: FieldError[] = [];

  let limit = DEFAULT_PAGE_SIZE;
  if (q.limit !== undefined) {
    const parsed = typeof q.limit === "string" && /^\d+$/.test(q.limit) ? Number(q.limit) : NaN;
    if (!(parsed >= 1 && parsed <= MAX_PAGE_SIZE)) {
      errors.push({ field: "limit", message: `must be an integer between 1 and ${MAX_PAGE_SIZE}` });
    } else {
      limit = parsed;
    }
  }

  let cursor: Cursor | null = null;
  if (q.cursor !== undefined && q.cursor !== "") {
    cursor = typeof q.cursor === "string" ? decodeCursor(q.cursor) : null;
    if (cursor === null) errors.push({ field: "cursor", message: "is not a valid cursor" });
  }

  const statuses = parseStatuses(q.status, errors);

  if (errors.length > 0) throw validationError(errors);
  return { limit, cursor, statuses };
}
