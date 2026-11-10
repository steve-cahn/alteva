import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import type { Pool } from "pg";
import type { BrokerStatus } from "./broker";
import { handleError, handleNotFound } from "./errors";
import { registerRoutes } from "./routes";

export interface AppOptions {
  pool: Pool;
  broker: BrokerStatus;
  /** Nudges the outbox relay to publish now; called after a job (and its root message) is committed. */
  outbox: { wake(): void };
  corsOrigins: string[];
  defaultMaxDepth: number;
  defaultMaxPages: number;
  /** Fastify logger config; `{ stream }` lets tests capture log lines. */
  logger?: FastifyServerOptions["logger"];
}

export const CORRELATION_HEADER = "x-correlation-id";
const SAFE_CORRELATION_ID = /^[\w.:-]{1,128}$/;

/** Reuses the caller's correlation id when it is sane, so one id can follow a request across services. */
function correlationIdFor(headerValue: unknown): string {
  return typeof headerValue === "string" && SAFE_CORRELATION_ID.test(headerValue) ? headerValue : randomUUID();
}

/**
 * Adds `jobId` to every later log line of this request. Fastify logs "request completed" through
 * `reply.log`, which was created before the route ran, so both loggers have to be rebound.
 */
export function bindJobToLogs(request: FastifyRequest, reply: FastifyReply, jobId: string): void {
  request.log = request.log.child({ jobId });
  reply.log = request.log;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 16 * 1024,
    // A client that sends its request too slowly, or sits on an idle connection, cannot hold a
    // socket forever (Node's defaults for both are "no limit").
    requestTimeout: 30_000,
    connectionTimeout: 60_000,
    genReqId: (req) => correlationIdFor(req.headers[CORRELATION_HEADER]),
    // Every log line for a request carries `correlationId` (the request id).
    requestIdLogLabel: "correlationId",
  });

  await app.register(cors, {
    origin: options.corsOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type", CORRELATION_HEADER],
    exposedHeaders: [CORRELATION_HEADER],
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header(CORRELATION_HEADER, request.id);
  });
  // Add jobId to the request's logger for every route that addresses a job.
  app.addHook("preHandler", async (request, reply) => {
    const id = (request.params as { id?: unknown } | undefined)?.id;
    if (typeof id === "string") bindJobToLogs(request, reply, id);
  });

  app.setErrorHandler(handleError);
  app.setNotFoundHandler(handleNotFound);
  registerRoutes(app, options);
  return app;
}
