import { describe, expect, it } from "vitest";
import { ConfigError } from "@alteva/core";
import { loadConfig } from "../src/config";

const base = { DATABASE_URL: "postgres://u:p@db:5432/x", RABBITMQ_URL: "amqp://u:p@mq:5672" };
const bad = (env: Record<string, string>, message: RegExp) => {
  try {
    loadConfig({ ...base, ...env });
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(message);
    return;
  }
  throw new Error("expected a ConfigError");
};

describe("api loadConfig", () => {
  it("applies sensible defaults when only the connections are given", () => {
    expect(loadConfig(base)).toMatchObject({
      port: 4000,
      logLevel: "info",
      corsOrigins: ["http://localhost:3000", "http://localhost:3100"],
      defaultMaxDepth: 2,
      defaultMaxPages: 200,
      jobTimeoutMinutes: 30,
    });
  });

  it("reads every setting from the environment", () => {
    const config = loadConfig({
      ...base,
      PORT: "8080",
      LOG_LEVEL: "debug",
      CORS_ORIGIN: "https://a.test, https://b.test",
      DEFAULT_MAX_DEPTH: "3",
      DEFAULT_MAX_PAGES: "50",
      JOB_TIMEOUT_MINUTES: "5",
      MIGRATIONS_DIR: "/app/migrations",
    });
    expect(config).toMatchObject({
      port: 8080,
      logLevel: "debug",
      corsOrigins: ["https://a.test", "https://b.test"],
      defaultMaxDepth: 3,
      defaultMaxPages: 50,
      jobTimeoutMinutes: 5,
      migrationsDir: "/app/migrations",
    });
  });

  it("requires both connection URLs", () => {
    expect(() => loadConfig({ RABBITMQ_URL: base.RABBITMQ_URL })).toThrow(/DATABASE_URL is required/);
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(/RABBITMQ_URL is required/);
  });

  it("rejects URLs of the wrong kind", () => {
    bad({ DATABASE_URL: "mysql://h/db" }, /DATABASE_URL must start with postgres:/);
    bad({ RABBITMQ_URL: "http://h" }, /RABBITMQ_URL must start with amqp:/);
  });

  it.each([["PORT", "0"], ["PORT", "70000"], ["PORT", "http"], ["DEFAULT_MAX_PAGES", "0"], ["DEFAULT_MAX_PAGES", "lots"], ["DEFAULT_MAX_DEPTH", "-1"], ["JOB_TIMEOUT_MINUTES", "0"], ["LOG_LEVEL", "loud"]])(
    "rejects %s=%s, naming the variable",
    (name, value) => {
      bad({ [name]: value }, new RegExp(name));
    },
  );

  it("rejects a default depth beyond the page limit, since no crawl could reach it", () => {
    bad({ DEFAULT_MAX_DEPTH: "50", DEFAULT_MAX_PAGES: "10" }, /DEFAULT_MAX_DEPTH \(50\) cannot exceed DEFAULT_MAX_PAGES \(10\)/);
  });

  it("treats a blank variable as unset instead of reading it as 0", () => {
    expect(loadConfig({ ...base, PORT: "", DEFAULT_MAX_PAGES: "" })).toMatchObject({ port: 4000, defaultMaxPages: 200 });
  });

  it("keeps the shutdown time under a typical container grace period", () => {
    expect(loadConfig(base).shutdownTimeoutMs).toBeLessThan(30_000);
  });
});
