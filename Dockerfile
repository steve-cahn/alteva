# One Dockerfile for all services: build with `--target api|worker|web`.
#
# api and worker are compiled to a single file each (see scripts/bundle.mjs), so their images hold
# only Node and that file: no node_modules, no TypeScript, no pnpm, and they run as the unprivileged
# `node` user with Node as PID 1 (so SIGTERM reaches the app and its shutdown handler).
#
# Dependency installs here are `--frozen-lockfile`: exact versions with integrity hashes, nothing is
# resolved. `--config.minimumReleaseAge=0` skips pnpm's supply-chain check of each package's publish
# date, which is meant for choosing new versions on a developer's machine (the lockfile was checked
# when it was written) and which costs one registry round-trip per package: minutes on a slow link.

FROM node:24-alpine AS base
RUN npm install -g pnpm@12.18.0
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/

# The api and worker need only their own dependencies (about a third of the workspace): not the web
# app's Next.js, Tailwind and ESLint. The store is a build cache, so a retry reuses what it fetched.
FROM base AS services
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store --config.minimumReleaseAge=0 \
      --filter "@alteva/api..." --filter "@alteva/worker..." --workspace-root
COPY . .
# Node runs the bundler directly. `pnpm run` would first check that node_modules matches the whole
# workspace, find it does not (this install is deliberately partial), and install everything.
RUN cd apps/api && node ../../scripts/bundle.mjs && cd ../worker && node ../../scripts/bundle.mjs

FROM base AS web-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store --config.minimumReleaseAge=0
COPY . .

FROM node:24-alpine AS api
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=services --chown=node:node /repo/apps/api/dist ./dist
COPY --from=services --chown=node:node /repo/db/migrations ./migrations
USER node
CMD ["node", "--enable-source-maps", "dist/index.mjs"]

FROM node:24-alpine AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=services --chown=node:node /repo/apps/worker/dist ./dist
USER node
CMD ["node", "--enable-source-maps", "dist/index.mjs"]

FROM web-deps AS web
WORKDIR /repo/apps/web
# Inlined into the browser bundle at build time: it must be the api address as the BROWSER sees it.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm build
ENV NODE_ENV=production
# `next start` writes its cache under .next; nothing else needs to be writable.
RUN chown -R node:node /repo/apps/web/.next
USER node
CMD ["node", "node_modules/next/dist/bin/next", "start"]
