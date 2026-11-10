import { describe, expect, it } from "vitest";
import { ConfigError } from "@alteva/core";
import { loadConfig } from "../src/config";

const base = { DATABASE_URL: "postgres://u:p@db:5432/x", RABBITMQ_URL: "amqp://u:p@mq:5672" };

describe("worker loadConfig", () => {
  it("applies defaults, including a prefetch of 5 and a shutdown time under a container's grace period", () => {
    expect(loadConfig(base)).toMatchObject({ port: 4001, logLevel: "info", prefetch: 5 });
    expect(loadConfig(base).shutdownTimeoutMs).toBeLessThan(30_000);
  });

  it("reads the port and log level", () => {
    expect(loadConfig({ ...base, PORT: "9000", LOG_LEVEL: "warn" })).toMatchObject({ port: 9000, logLevel: "warn" });
  });

  it.each([
    [{ DATABASE_URL: "" }, /DATABASE_URL is required/],
    [{ RABBITMQ_URL: "" }, /RABBITMQ_URL is required/],
    [{ DATABASE_URL: "redis://h" }, /DATABASE_URL must start with/],
    [{ PORT: "abc" }, /PORT must be a whole number/],
    [{ PORT: "99999" }, /PORT must be at most 65535/],
    [{ LOG_LEVEL: "chatty" }, /LOG_LEVEL must be one of/],
  ])("rejects %j", (override, message) => {
    try {
      loadConfig({ ...base, ...override });
      throw new Error("expected a ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toMatch(message);
    }
  });

  it("never echoes a connection string, which holds a password, in an error", () => {
    try {
      loadConfig({ ...base, DATABASE_URL: "mysql://admin:hunter2@h/db" });
    } catch (err) {
      expect((err as Error).message).not.toContain("hunter2");
    }
  });
});
