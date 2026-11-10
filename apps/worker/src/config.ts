import { choiceEnv, intEnv, urlEnv, type Env } from "@alteva/core";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export interface WorkerConfig {
  port: number;
  databaseUrl: string;
  rabbitmqUrl: string;
  logLevel: (typeof LOG_LEVELS)[number];
  /** Messages in flight per worker; also how many pages are processed concurrently. */
  prefetch: number;
  /** After SIGTERM, how long to wait for in-flight pages before exiting anyway. Keep it under the container's stop grace period. */
  shutdownTimeoutMs: number;
}

/** Reads and validates the environment. Throws a `ConfigError` naming the bad variable, so a typo fails at startup. */
export function loadConfig(env: Env = process.env): WorkerConfig {
  return {
    port: intEnv(env, "PORT", 4001, { min: 1, max: 65535 }),
    databaseUrl: urlEnv(env, "DATABASE_URL", ["postgres:", "postgresql:"]),
    rabbitmqUrl: urlEnv(env, "RABBITMQ_URL", ["amqp:", "amqps:"]),
    logLevel: choiceEnv(env, "LOG_LEVEL", LOG_LEVELS, "info"),
    prefetch: 5,
    shutdownTimeoutMs: 25_000,
  };
}
