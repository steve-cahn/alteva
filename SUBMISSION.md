# Submission summary

A job-based web crawler: submit a URL, it is crawled asynchronously by a pool of workers, and the UI shows live progress, then a tree of the pages found with each page's **Domain Link Ratio** (links that stay on the site ÷ all links on the page). Full documentation is in [README.md](README.md); the reasoning behind the main choices is in [docs/DECISIONS.md](docs/DECISIONS.md), and the structure in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it

```bash
docker compose up --build          # postgres, rabbitmq, api, worker, web (first build takes a few minutes)
# UI  http://localhost:3100    API  http://localhost:4000    RabbitMQ UI  http://localhost:15672
pnpm install && pnpm test:integration   # every test suite, against a real Postgres
```

## What I built, in the order I built it, and why

1. **The domain logic** (`packages/core`): URL normalization, link extraction, the ratio. Correctness and edge cases carry the most weight, and pure functions are cheap to test exhaustively.
2. **The schema and the worker's page pipeline.** Everything else depends on one transaction being right: claim the page, record its links, create child pages, update the job's counters. This got the most testing.
3. **Retries and the dead-letter queue**, then the **API**, then the **UI**, tied together by an integration test that crawls local HTML fixtures over real HTTP into a real Postgres.
4. **Hardening afterwards**: a transactional outbox, a fuller HTTP retry policy, server-side history filtering, and a UI redesign.

## Choices and trade-offs

| Choice | Why | What it costs |
|---|---|---|
| One message per page | Work spreads across workers; one slow page never stalls a job; retries and dead-lettering apply to a single page | De-duplication, the page budget and completion detection have to be done in the database |
| Idempotent worker: claim with `UPDATE … WHERE status = 'queued'`, unique keys on pages and edges, one transaction per page | A message delivered twice changes nothing | Workers on the *same* job serialize on a job-row lock (different jobs run in parallel). Chosen for exactness over throughput |
| **Transactional outbox** | A page's children and their messages commit together, so a crash or a broker outage can never leave a page queued with no message | An extra table and a relay, plus a few milliseconds of latency |
| Two-level retry: quick in-process retries (backoff, jitter, `Retry-After`), then a TTL retry queue, then a DLQ | Transient and permanent failures are treated differently; nothing is silently dropped | More moving parts than a single retry loop |
| Plain SQL with `pg`, no ORM | The interesting parts are locks and conditional updates; they stay visible and directly testable | No query builder or migration tooling beyond a small runner |
| Keyset pagination for history | Constant cost per page, no skipped or repeated rows | No total count, no page numbers |

## How I know it works

- **609 automated tests, all passing:** core 113, api 174, worker 173, web 149. They include unit tests for URL normalization and the ratio, an integration test over local HTML fixtures, a test that delivers every message twice, retry/DLQ routing, and component tests for the UI. I broke the code on purpose in several places to check that the tests fail when they should.
- **The full stack, run for real** with `docker compose`: a crawl of a 74-page site completed through the real API, worker, RabbitMQ and Postgres.
- **The hardened containers, run for real:** the api and worker images are ~172 MB and ~175 MB (down from ~885 MB), contain only Node and the compiled file, and run as an unprivileged user with a read-only filesystem and no extra capabilities. `docker stop` exits 0 with `shutting down` then `shutdown complete` and no false error. With `--scale worker=3` a 200-page crawl completed with the work split 89/50/61 and exactly 200 distinct pages. Stopping every worker in the *middle* of a crawl and restarting them completed it with nothing lost or duplicated. Bad configuration (`PORT=abc`, a blank limit, a depth beyond the page limit, a wrong URL scheme) fails at startup naming the variable, without echoing a connection string.
- **A broker outage:** with RabbitMQ stopped, the API kept accepting jobs, the messages waited in the outbox, and when RabbitMQ returned the crawl completed (74 of 74 pages).
- **A measurement, not a guess:** on 200,000 jobs, filtering history by a rare status takes 0.3 ms with the new index versus 14.5 ms without it. The same measurement showed the index does *not* help the per-status counts (about 19 ms either way), so I corrected a claim I had made.

## Built to run, not just to demo

Beyond the features, the processes are written to behave well when things go wrong (details in the README's *Operational behavior* and ADR-011):

- **Graceful shutdown** that stops taking work, lets in-progress pages finish and be acknowledged, publishes what they queued, closes everything and exits 0. I found and fixed a defect here: a deliberate shutdown used to log a false "connection lost" error and skip closing the database pool.
- **Strict configuration** that fails at startup naming the bad variable (`PORT=abc`, a blank limit, a wrong URL scheme) and never echoes a connection string.
- **Database limits**: statement, lock and idle-in-transaction timeouts, so a hung query cannot hold a job's row lock and stall every worker on that job. These are tested against a real Postgres, and a timeout is retried rather than failing a page.
- **API request and connection timeouts**, and structured fatal logging of any unhandled error.
- **Compiled, minimal containers:** the api and worker are bundled into one file each and run as an unprivileged user with Node as PID 1, a read-only filesystem and no extra capabilities. Postgres and RabbitMQ are bound to the host's loopback, passwords come from the environment, and workers scale with `--scale worker=N`.

## Where I deviated from the brief, and what I assumed

- **Node/TypeScript instead of .NET 8.** I was given permission to build it in Node/TypeScript; the architecture the brief asks for (separate API and worker processes, a broker, SQL persistence, clean layering) is the same.
- **`www.example.com` counts as the same site as `example.com`,** and the starting domain follows a redirect of the start URL (an `http` to `https` or `www` redirect, or a move to another domain). Otherwise most sites would report every link as external.
- **`maxDepth`** accepts any whole number from 0 (the start page only) up to the page limit (200), because a deeper value cannot change the result. The UI offers 0–5.
- **A start page that cannot be crawled fails the job** with a reason; a broken link deeper in a site does not.
- **Links back to the page itself** (including `#anchors`) are not counted as outgoing links, so they cannot inflate the ratio.

## What I cut, and what is next

**Cut:** server push (the UI polls every 1.5 s, which the brief accepts), JavaScript rendering, `robots.txt` and per-host politeness, authentication.

**Known limitations** (the README has the full list): not hardened for the open internet (no authentication, TLS, rate limiting or metrics, and no SSRF protection, so the API will crawl any http(s) URL, including `localhost`), a JavaScript-rendered site looks like a page with no links, and the CI workflow has not yet run on GitHub.

**Next, in order:** SSRF protection, live progress over SSE, metrics (queue depth, outbox backlog, retry and DLQ rates), tooling to inspect and replay the DLQ.
