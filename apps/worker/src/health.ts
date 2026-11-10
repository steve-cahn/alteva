import { createServer, type Server } from "node:http";
import type { Logger } from "pino";

export interface HealthChecks {
  database: () => Promise<void>;
  channelOpen: () => boolean;
}

/** GET /health → 200 when the database answers and the broker channel is open, else 503. */
export function startHealthServer(port: number, checks: HealthChecks, log: Logger): Promise<Server> {
  const server = createServer(async (req, res) => {
    if (req.method !== "GET" || req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    const status = await collectStatus(checks, log);
    const healthy = status.database && status.channel;
    res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: healthy ? "ok" : "unavailable", ...status }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve(server));
  });
}

async function collectStatus(checks: HealthChecks, log: Logger) {
  const database = await checks.database().then(
    () => true,
    (err) => {
      log.error({ err }, "health: database check failed");
      return false;
    },
  );
  return { database, channel: checks.channelOpen() };
}
