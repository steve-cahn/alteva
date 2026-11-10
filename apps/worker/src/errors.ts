/**
 * Error classification. The rule of thumb: if trying again later could plausibly succeed, it is
 * transient (retry queue); if the same input will fail the same way, it is permanent.
 *
 * Fetch outcomes: timeouts, connection resets/refusals, DNS errors, HTTP 5xx and 429 are
 * transient; HTTP 4xx, non-HTML, oversized bodies, TLS and malformed-URL errors are permanent.
 * Database: connection-level failures are transient; constraint and syntax errors are not.
 */

/** A failure worth retrying later. Carries what to record on the page if retries run out. */
export class TransientError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "TransientError";
  }
}

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

export function errorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

/** Fetch-side: timeout, reset, refused, DNS. */
export function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof Error && err.name === "TimeoutError") return true;
  const code = errorCode(err);
  return code !== undefined && TRANSIENT_NETWORK_CODES.has(code);
}

// SQLSTATE: 08 connection exception, 57P admin shutdown/cannot connect now, 53 insufficient
// resources (e.g. too many connections), 40001 serialization failure, 40P01 deadlock, 57014 statement
// timeout / query canceled, 55P03 lock timeout. The last two are our own pool limits firing: try again.
const TRANSIENT_SQLSTATE = /^(08|57P|53)|^(40001|40P01|57014|55P03)$/;
// pg and pg-pool raise some connection failures without a code.
const TRANSIENT_DB_MESSAGE = /connection terminated|timeout exceeded when trying to connect|database system is (starting up|shutting down)/i;

/** Database-side: connection loss and other conditions that clear up on their own. */
export function isTransientDbError(err: unknown): boolean {
  const code = errorCode(err);
  if (code && (TRANSIENT_SQLSTATE.test(code) || TRANSIENT_NETWORK_CODES.has(code))) return true;
  return err instanceof Error && TRANSIENT_DB_MESSAGE.test(err.message);
}

/** Anything thrown out of the pipeline that is worth another attempt. */
export function isTransient(err: unknown): boolean {
  return err instanceof TransientError || isTransientDbError(err);
}

export function failureOf(err: unknown): { httpStatus: number | null; message: string } {
  if (err instanceof TransientError) return { httpStatus: err.httpStatus, message: err.message };
  return { httpStatus: null, message: err instanceof Error ? err.message : String(err) };
}
