import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join } from "node:path";
import pg from "pg";

const DB_URL = process.env.DATABASE_URL ?? "postgres://alteva:alteva_password@localhost:5442/alteva_db";
const MIGRATIONS_DIR = new URL("../../../db/migrations/", import.meta.url);
/** Every migration, in order, exactly as the api applies them. */
const MIGRATION = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), "utf8"))
  .join("\n");

export interface TestDb {
  pool: pg.Pool;
  close: () => Promise<void>;
}

/**
 * True when the local Postgres from docker compose answers. DB tests skip otherwise, loudly; set
 * REQUIRE_DB=1 (CI, `pnpm test:integration`) to make an unreachable database a failure instead,
 * so an integration suite can never go green by silently not running.
 */
export async function postgresAvailable(): Promise<boolean> {
  const up = await canConnect();
  if (!up && process.env.REQUIRE_DB) throw new Error(`REQUIRE_DB is set but Postgres is not reachable at ${new URL(DB_URL).host}`);
  if (!up) console.warn("Postgres is not reachable: database tests are SKIPPED (docker compose up -d postgres)");
  return up;
}

async function canConnect(): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: DB_URL, connectionTimeoutMillis: 1_000 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

/** A pool bound to a throwaway schema holding the real migration, so tests never touch real tables. */
export async function createTestDb(): Promise<TestDb> {
  const schema = `test_${randomUUID().replace(/-/g, "")}`;
  const admin = new pg.Pool({ connectionString: DB_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: DB_URL, options: `-c search_path=${schema}` });
  await pool.query(MIGRATION);
  return {
    pool,
    close: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

export async function seedJob(
  pool: pg.Pool,
  opts: { url: string; startHost: string; maxDepth?: number; maxPages?: number; status?: string },
): Promise<{ jobId: string; rootPageId: string }> {
  const job = await pool.query<{ id: string }>(
    `INSERT INTO jobs (url, start_host, max_depth, max_pages, status, pages_discovered)
     VALUES ($1, $2, $3, $4, $5, 1) RETURNING id`,
    [opts.url, opts.startHost, opts.maxDepth ?? 2, opts.maxPages ?? 200, opts.status ?? "Pending"],
  );
  const page = await pool.query<{ id: string }>(
    "INSERT INTO pages (job_id, normalized_url, depth) VALUES ($1, $2, 0) RETURNING id",
    [job.rows[0].id, opts.url],
  );
  return { jobId: job.rows[0].id, rootPageId: page.rows[0].id };
}

const CONTENT_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".pdf": "application/pdf" };

/** Serves test/fixtures/site over HTTP. `/x` maps to x.html, `/` to index.html, unknown paths 404. */
export interface FixtureSite {
  server: Server;
  baseUrl: string;
  host: string;
  /** Every request the server received, as `path?query`, in order. */
  requests: string[];
}

export async function startFixtureServer(port = 0): Promise<FixtureSite> {
  const root = new URL("./fixtures/site/", import.meta.url).pathname;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "/");
    const path = new URL(req.url ?? "/", "http://x").pathname.replace(/\/+$/, "") || "/index";
    const file = extname(path) ? path : `${path}.html`;
    try {
      const body = readFileSync(join(root, file === "/.html" ? "/index.html" : file));
      res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/html" }).end("<h1>not found</h1>");
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: bound } = server.address() as { port: number };
  return { server, baseUrl: `http://127.0.0.1:${bound}`, host: "127.0.0.1", requests };
}

/** Polls until `check` is true, instead of sleeping a fixed time and hoping: robust on a loaded machine. */
export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 8_000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
