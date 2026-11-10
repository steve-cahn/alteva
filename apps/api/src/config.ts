import { choiceEnv, ConfigError, intEnv, listEnv, stringEnv, urlEnv, type Env } from "@alteva/core";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export interface ApiConfig {
  port: number;
  databaseUrl: string;
  rabbitmqUrl: string;
  logLevel: (typeof LOG_LEVELS)[number];
  migrationsDir: string;
  /** Browser origins allowed to call the api: 3000 for `pnpm dev`, 3100 for compose. */
  corsOrigins: string[];
  defaultMaxDepth: number;
  defaultMaxPages: number;
  /** A job still unfinished after this long is failed by the reaper (see failStaleJobs). */
  jobTimeoutMinutes: number;
  reaperIntervalMs: number;
  /** After SIGTERM, how long to wait before exiting anyway. Keep it under the container's stop grace period. */
  shutdownTimeoutMs: number;
}

/** Reads and validates the environment. Throws a `ConfigError` naming the bad variable, so a typo fails at startup. */
export function loadConfig(env: Env = process.env): ApiConfig {
  const config: ApiConfig = {
    port: intEnv(env, "PORT", 4000, { min: 1, max: 65535 }),
    databaseUrl: urlEnv(env, "DATABASE_URL", ["postgres:", "postgresql:"]),
    rabbitmqUrl: urlEnv(env, "RABBITMQ_URL", ["amqp:", "amqps:"]),
    logLevel: choiceEnv(env, "LOG_LEVEL", LOG_LEVELS, "info"),
    migrationsDir: stringEnv(env, "MIGRATIONS_DIR", new URL("../../../db/migrations", import.meta.url).pathname),
    corsOrigins: listEnv(env, "CORS_ORIGIN", ["http://localhost:3000", "http://localhost:3100"]),
    // Both ends are bounded by what the database column and the crawl can hold.
    defaultMaxDepth: intEnv(env, "DEFAULT_MAX_DEPTH", 2, { min: 0, max: 1000 }),
    defaultMaxPages: intEnv(env, "DEFAULT_MAX_PAGES", 200, { min: 1, max: 100_000 }),
    jobTimeoutMinutes: intEnv(env, "JOB_TIMEOUT_MINUTES", 30, { min: 1, max: 1440 }),
    reaperIntervalMs: 60_000,
    shutdownTimeoutMs: 25_000,
  };
  if (config.defaultMaxDepth > config.defaultMaxPages) {
    throw new ConfigError(`DEFAULT_MAX_DEPTH (${config.defaultMaxDepth}) cannot exceed DEFAULT_MAX_PAGES (${config.defaultMaxPages})`);
  }
  return config;
}
