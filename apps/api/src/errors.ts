import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

export interface FieldError {
  field: string;
  message: string;
}

/** An error with a status and a stable machine-readable code, safe to show to the client. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: FieldError[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const validationError = (details: FieldError[]) =>
  new ApiError(400, "VALIDATION_ERROR", "Request validation failed", details);
export const notFound = (what: string) => new ApiError(404, "NOT_FOUND", `${what} not found`);
export const conflict = (message: string) => new ApiError(409, "CONFLICT", message);
export const unavailable = (message: string) => new ApiError(503, "SERVICE_UNAVAILABLE", message);

/**
 * Every error response has this shape:
 *   { "error": { "code": "...", "message": "...", "details"?: [...], "correlationId": "..." } }
 */
interface ErrorBody {
  error: { code: string; message: string; details?: FieldError[]; correlationId: string };
}

const CLIENT_ERROR_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  404: "NOT_FOUND",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
};

export function sendError(reply: FastifyReply, correlationId: string, status: number, code: string, message: string, details?: FieldError[]) {
  const body: ErrorBody = { error: { code, message, ...(details && { details }), correlationId } };
  return reply.code(status).send(body);
}

export function handleError(error: FastifyError | ApiError, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ApiError) {
    return sendError(reply, request.id, error.statusCode, error.code, error.message, error.details);
  }
  const status = (error as FastifyError).statusCode;
  if (status && status >= 400 && status < 500) {
    // Fastify's own client errors: malformed JSON, wrong content type, body too large, ...
    return sendError(reply, request.id, status, CLIENT_ERROR_CODES[status] ?? "BAD_REQUEST", error.message);
  }
  // Anything else is ours: log the cause, tell the client nothing about it.
  request.log.error({ err: error }, "unhandled error");
  return sendError(reply, request.id, 500, "INTERNAL_ERROR", "Internal server error");
}

export function handleNotFound(request: FastifyRequest, reply: FastifyReply) {
  return sendError(reply, request.id, 404, "NOT_FOUND", `Route ${request.method} ${request.url.split("?")[0]} not found`);
}
