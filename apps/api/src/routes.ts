import type { FastifyInstance } from "fastify";
import { buildPageTree } from "@alteva/core";
import { bindJobToLogs, type AppOptions } from "./app";
import { conflict, notFound } from "./errors";
import { cancelJob, createJob, getJob, getJobCounts, getPageCounts, getPageLinks, getTreeRows, listJobs } from "./jobs";
import { parseCreateJob, parseJobId, parseListQuery, parsePageId } from "./validation";

type Params = { id: string };

export function registerRoutes(app: FastifyInstance, { pool, broker, outbox, defaultMaxDepth, defaultMaxPages }: AppOptions): void {
  // 202 Accepted: the job exists, and its first message is committed to the outbox, but the crawl
  // itself happens later. The job is usable (Pending) even if the broker is down at this moment.
  app.post("/api/jobs", async (request, reply) => {
    const input = parseCreateJob(request.body, defaultMaxDepth, defaultMaxPages);
    const jobId = await createJob(pool, { ...input, maxPages: defaultMaxPages, correlationId: request.id });
    bindJobToLogs(request, reply, jobId);
    outbox.wake();
    request.log.info({ url: input.url, maxDepth: input.maxDepth }, "job created");
    return reply.code(202).header("location", `/api/jobs/${jobId}`).send({ jobId });
  });

  app.get<{ Params: Params }>("/api/jobs/:id", async (request) => {
    const id = parseJobId(request.params.id);
    const job = await getJob(pool, id);
    if (!job) throw notFound("Job");
    return { ...job, pageCounts: await getPageCounts(pool, id) };
  });

  app.get<{ Params: Params }>("/api/jobs/:id/tree", async (request) => {
    const id = parseJobId(request.params.id);
    const job = await getJob(pool, id);
    if (!job) throw notFound("Job");
    // The tree is partial while the job runs: pages not yet crawled show status "queued".
    return { jobId: id, status: job.status, tree: buildPageTree(await getTreeRows(pool, id)) };
  });

  app.get<{ Params: Params & { pageId: string } }>("/api/jobs/:id/pages/:pageId/links", async (request) => {
    const jobId = parseJobId(request.params.id);
    const links = await getPageLinks(pool, jobId, parsePageId(request.params.pageId));
    if (!links) throw notFound("Page");
    return { ...links, truncated: links.total > links.links.length };
  });

  app.get("/api/jobs", async (request) => {
    const { limit, cursor, statuses } = parseListQuery(request.query);
    return listJobs(pool, limit, cursor, statuses);
  });

  // Totals by status over the whole history, for the filter chips. (A fixed path: it never reaches /api/jobs/:id.)
  app.get("/api/jobs/counts", async () => getJobCounts(pool));

  // Idempotent: canceling a Canceled job returns it again. Completed and Failed jobs cannot be canceled.
  app.post<{ Params: Params }>("/api/jobs/:id/cancel", async (request) => {
    const id = parseJobId(request.params.id);
    const canceled = await cancelJob(pool, id);
    if (canceled) {
      request.log.info("job canceled");
      return canceled;
    }
    const job = await getJob(pool, id);
    if (!job) throw notFound("Job");
    if (job.status === "Canceled") return job;
    throw conflict(`Job is already ${job.status} and cannot be canceled`);
  });

  app.get("/health", async (request, reply) => {
    const database = await pool.query("SELECT 1").then(
      () => true,
      (err) => (request.log.error({ err }, "health: database check failed"), false),
    );
    const brokerUp = broker.isHealthy();
    const healthy = database && brokerUp;
    return reply.code(healthy ? 200 : 503).send({ status: healthy ? "ok" : "unavailable", database, broker: brokerUp });
  });
}
