# Decisions

Short records of the choices that shape the system: what was decided, why, and what it costs.

## ADR-001: Node/TypeScript instead of .NET 8

**Context.** The assignment names .NET 8 / ASP.NET Core and React. I had permission to use Node/TypeScript.
**Decision.** Fastify for the API and worker, Next.js for the UI, in a pnpm monorepo.
**Consequences.** One language across API, worker, UI and the shared domain package, so `core` is imported by both services with no duplication. The architecture the assignment cares about (separate API and worker processes, a broker, SQL persistence, clean layering) is the same. A reviewer expecting .NET will not find it.

## ADR-002: One message per page, not per job

**Context.** A crawl could be one long task or many small ones.
**Decision.** Each page is a message.
**Consequences.** Work spreads across worker replicas, one slow or failing page does not stall the rest, retries and dead-lettering apply to a single page, and at-least-once delivery is exercised constantly. The price is coordination: de-duplication, a page budget and completion detection have to be done in the database (ADR-004).

## ADR-003: PostgreSQL with plain SQL, no ORM

**Context.** The interesting parts are concurrency and idempotency, which depend on exact statements.
**Decision.** `pg` with hand-written SQL and numbered migrations.
**Consequences.** Every lock, conditional update and `ON CONFLICT` is visible in the code and can be tested directly against a real database. No query builder to hide behaviour; no migration tooling beyond a small runner.

## ADR-004: Job row lock plus a conditional update

**Context.** Several workers process pages of the same job at once. Three things must be exact under concurrency: a duplicate delivery must not change anything, the page budget must not be exceeded, and the job must complete exactly once.
**Decision.** Each page's transaction first locks the job row (`SELECT ... FOR UPDATE`), then claims the page with `UPDATE pages ... WHERE status = 'queued' RETURNING id`. Unique keys on `pages` and `edges` back this up. Progress is counted in `jobs.pages_discovered` / `pages_processed`, updated in one statement that also decides `Completed`.
**Consequences.** Simple, and correct by construction: reading the budget and incrementing it cannot interleave. The cost is that workers on the *same* job serialize on that lock, which is fine for jobs of at most a few hundred pages, with the fetch (the slow part) done outside the lock. For very large jobs the next step is an atomic `UPDATE ... RETURNING` counter. Counters can in principle drift from the page rows; here they are written in the same transaction as the pages they count, so they do not.

## ADR-005: Transactional outbox

**Context.** A page's transaction creates child pages that need messages. Publishing after the commit leaves a window: if the broker refuses or the process dies in between, the pages exist but nothing will ever crawl them, and the job never finishes. The reverse (publish, then fail to commit) sends work for pages that do not exist.
**Decision.** Messages are written to an `outbox` table in the same transaction as the state they describe (job creation in the API, child pages in the worker). A relay publishes unpublished rows with publisher confirms and marks them. It claims rows with `FOR UPDATE SKIP LOCKED`, so the API and every worker can run one safely; it is woken after commits and also polls.
**Consequences.** State and messages commit together or not at all, and creating a job does not depend on the broker being up: the API starts without RabbitMQ, keeps accepting jobs while it is down (its `/health` says so), and reconnects by itself, after which the relay publishes what waited. The worker, which can do nothing without the broker, still exits on losing it and is restarted. Delivery becomes at-least-once on the publish side as well (a crash between publish and marking republishes), which the idempotent worker already assumes. Cost: a table, an extra hop of latency (milliseconds, since the relay is woken), and periodic deletion of old published rows. The mechanics live in `core` behind injected ports (a transaction runner and a publish function), the same pattern as `declareTopology`, so `core` still imports no database or broker library.

## ADR-006: Retry and dead-letter topology

**Context.** Failures differ: a timeout may succeed in ten seconds; a 404 never will; a malformed message never will.
**Decision.** Two levels. The fetcher retries transient errors in-process, quickly, with exponential backoff and jitter, honouring `Retry-After`, inside a total time budget. What is still transient is retried through the broker: a single `crawl.page.retry` queue with a 10 s TTL that dead-letters back to `crawl.page`, with an `x-attempt` header and a maximum of 3 attempts. Permanent failures (4xx, non-HTML, oversized, refused redirects) are recorded on the page and count as processed. Malformed messages, exhausted retries and unrecoverable errors go to `crawl.page.dlq`, after the page is marked failed so the job can still finish.
**Consequences.** Slow dependencies get time to recover without holding a worker. A failed page never blocks its job. Nothing is silently dropped: poison messages are kept in the DLQ for inspection and replay.

## ADR-007: What counts as the same page and the same site

**Context.** The ratio and the de-duplication depend on how URLs are compared.
**Decision.** URLs are normalized (fragment dropped, host lowercased, default port removed, trailing slash stripped from non-root paths; query kept). The site is identified by host with a leading `www.` ignored; links to it are canonicalized to the site's real origin, so `http`, `https` and `www` spellings are one page. The site's origin is learned from where the start page *finally* lands after redirects, so `example.com` redirecting to `www.example.com`, or to another domain, still crawls. Links back to the page itself (including `#anchors`) are not outgoing links. Relative links resolve against `<base href>`; `<a>` and `<area>` are read.
**Consequences.** Fewer duplicate pages and a ratio that means what a reader expects. A deliberate departure from "exact host only": `www.example.com` and `example.com` are one site. A redirect on a page other than the start page is not merged.

## ADR-008: Keyset pagination for history

**Context.** History is listed newest first and can grow without bound.
**Decision.** Order by `(created_at DESC, id DESC)` and page with a cursor holding both values, with `created_at` carried as Postgres text so microseconds survive.
**Consequences.** Constant cost per page, no skipped or repeated rows when jobs arrive between requests, no total count. Offset paging would have been simpler to build and to show a page number for.

**Filtering.** The status filter is applied in SQL (`status = ANY(...)`), not in the browser, so it covers the whole history rather than whatever has been loaded. The cursor is only a position in the `(created_at, id)` ordering, so it is valid under any filter; the client sends the same filter again with it. Because filtering on the client would make the chip counts wrong (they would count only loaded rows), a separate `GET /api/jobs/counts` returns totals by status. An index on `(status, created_at DESC, id DESC)` serves rare statuses: on 200,000 jobs, a status with 24 jobs went from 14.5 ms (full scan) to 0.3 ms; I measured rather than assumed, and also found it does not help the counts query (about 19 ms either way).

## ADR-009: A time limit on jobs

**Context.** If messages are lost, a job would stay `Running` forever.
**Decision.** The API checks every minute and fails jobs unfinished after `JOB_TIMEOUT_MINUTES` (30) with a clear reason.
**Consequences.** Nothing hangs indefinitely. A genuinely slow crawl longer than the limit is failed, so the limit is configurable.

## ADR-010: `maxDepth` has no arbitrary bound

**Context.** The brief gives `maxDepth` a default of 2 and no limits. An earlier version of the API accepted only 1–5, which rejected depth 0 and a larger value for no stated reason.
**Decision.** Accept any whole number from 0 up to the job's page limit (200 by default). Depth 0 crawls only the start page: its links are recorded and measured but not followed. The UI offers 0–5, which covers real use.
**Consequences.** Nothing the brief allows is refused. The only ceiling is one with a reason: a crawl cannot reach more pages than the page limit, so a larger depth could not change the result, and it keeps the value inside Postgres's integer range. No schema change was needed: `jobs.max_depth` already allowed 0 and the worker already stopped there.

## ADR-011: What "safe to run" means for the processes

**Context.** The first versions worked, but a review of how they behave when things go wrong found gaps: a deliberate shutdown logged a false "connection lost" error and skipped closing the database pool; a hung query could hold a job's row lock, and with it every worker on that job, for as long as the hang lasted; a mistyped environment variable (`Number("")` is 0, `Number("abc")` is NaN) produced a service running on nonsense; and the images ran TypeScript through `tsx` as root, started through `pnpm`.
**Decision.** Shutdown is an explicit, ordered, time-limited sequence that distinguishes closing the broker on purpose from losing it. The database pool sets statement, lock and idle-in-transaction timeouts, and timeouts are classified as transient so the retry queue handles them. Configuration is parsed strictly at startup and fails with a message naming the variable (a pure parser in `core`, unit tested). The API sets request and connection timeouts. Each service is compiled to one file by esbuild and runs as the unprivileged user with Node as PID 1, with credentials from the environment.
**Consequences.** Verified against the running containers: a stop exits 0 with a clean shutdown log; stopping every worker mid-crawl and restarting them completes the job with nothing lost or duplicated; the api and worker images are about 175 MB, run as an unprivileged user on a read-only filesystem, and workers scale with `--scale`. Deploys and restarts are quiet and lose no work; a stuck database call degrades into a retry instead of a stall; a bad deployment fails at once and says why. The cost is an extra build step and the discipline of keeping those timeouts above the real work (the page transaction is milliseconds, since the network fetch happens outside it). What this does not do: authentication, TLS, SSRF protection, rate limiting and metrics, all listed under known limitations.
