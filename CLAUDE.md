# CLAUDE.md

Job-based web crawler per `ASSIGNMENT.md`. Built in Node/TypeScript (permission granted in place of .NET 8). **4-hour time box**: prioritize correctness, idempotency and clarity over polish.

## Stack decisions

- **Monorepo**: pnpm workspaces.
  - `packages/core`: pure domain logic (URL normalization, link extraction, Domain Link Ratio, tree building). No I/O, no framework imports.
  - `apps/api`: Fastify REST API (orchestrator). Creates jobs, serves status, tree and history.
  - `apps/worker`: RabbitMQ consumer. Fetches pages, parses links, writes results, updates progress.
  - `apps/web`: Next.js App Router UI (Start Crawl, Job Details, History).
- **Database**: Postgres via plain SQL with `pg`. No ORM. Migrations are numbered `.sql` files, applied in order.
- **Broker**: RabbitMQ via `amqplib`. **One message per page, not per job.** Retry and DLQ queues are part of the topology. Messages are never published straight from a request or a page's processing: they are written to the `outbox` table in the same transaction as the state they describe, and a relay publishes them.
- **Logging**: `pino` structured logs. Every line carries `jobId` and `correlationId` (use child loggers).
- **Tests**: `vitest`. Required: unit tests for URL normalization and Domain Link Ratio, plus one integration-style test against local HTML fixtures.
- **Delivery**: `docker-compose.yml` runs api, worker, web, Postgres and RabbitMQ. Health endpoints for api and worker. README covers the items listed in `ASSIGNMENT.md`.

## Conventions

- Keep functions small and named for what they do. No over-engineering: no DI frameworks, no generic abstractions without a second user.
- Dependencies point inward: `apps/*` import `packages/core`; `core` imports nothing from `apps/*`.
- The worker must be idempotent (at-least-once delivery). Use unique keys and `INSERT ... ON CONFLICT` for pages and edges, scoped by job.
- Distinguish transient failures (retry with backoff) from poison messages (DLQ). Document both in the README.
- Write explicit error handling at boundaries (HTTP fetch, DB, broker). Don't swallow errors.

## Next.js warning

`apps/web` uses a Next.js version with breaking changes from what you may know. See `AGENTS.md`: read the relevant guide in `node_modules/next/dist/docs/` before writing any web code, and heed deprecation notices.

## Current state

All services are built and verified: `packages/core` (domain logic, message types, queue topology, outbox mechanics), `apps/api` (Fastify), `apps/worker` (RabbitMQ consumer) and `apps/web` (Next.js). Migrations `001`–`004` live in `db/migrations`. `docker compose up --build` runs Postgres, RabbitMQ, api, worker and web, each with a healthcheck. Run `pnpm test:integration` for every suite against a real Postgres. The api and worker are compiled to one file each by `pnpm build:services` (esbuild, `scripts/bundle.mjs`) and the images contain only that file: `start` runs the TypeScript for development, `start:prod` runs the bundle. Configuration is read strictly through `loadConfig` (see `packages/core/src/env.ts`). See `README.md` and `docs/` for the design, and rebuild a compose image after changing its code (`docker compose up -d --build <service>`), since images are snapshots.

## README must also include

What was implemented first and why, what was cut and why, and what would come next (per `ASSIGNMENT.md` guidance).
