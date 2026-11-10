import { describe, expect, it } from "vitest";
import { failureOf, isTransient, isTransientDbError, isTransientNetworkError, TransientError } from "../src/errors";

const withCode = (code: string, message = "boom") => Object.assign(new Error(message), { code });
const withCause = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });

describe("isTransientNetworkError", () => {
  it("treats timeouts as transient", () => {
    expect(isTransientNetworkError(new DOMException("timed out", "TimeoutError"))).toBe(true);
  });

  it.each(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"])(
    "treats %s as transient, on the error or on its cause",
    (code) => {
      expect(isTransientNetworkError(withCode(code))).toBe(true);
      expect(isTransientNetworkError(withCause(code))).toBe(true);
    },
  );

  it.each([
    ["a TLS certificate error", withCause("DEPTH_ZERO_SELF_SIGNED_CERT")],
    ["an invalid URL", new TypeError("Invalid URL")],
    ["a redirect loop", new TypeError("fetch failed", { cause: new Error("redirect count exceeded") })],
    ["a non-error value", "nope"],
  ])("treats %s as permanent", (_name, err) => {
    expect(isTransientNetworkError(err)).toBe(false);
  });
});

describe("isTransientDbError", () => {
  it.each([
    ["connection exception (08006)", withCode("08006")],
    ["admin shutdown (57P01)", withCode("57P01")],
    ["too many connections (53300)", withCode("53300")],
    ["serialization failure (40001)", withCode("40001")],
    ["deadlock (40P01)", withCode("40P01")],
    ["statement timeout (57014)", withCode("57014")],
    ["lock timeout (55P03)", withCode("55P03")],
    ["socket reset", withCode("ECONNRESET")],
    ["pool: connection terminated", new Error("Connection terminated unexpectedly")],
    ["pool: connect timeout", new Error("timeout exceeded when trying to connect")],
    ["server starting up", new Error("the database system is starting up")],
  ])("treats %s as transient", (_name, err) => {
    expect(isTransientDbError(err)).toBe(true);
  });

  it.each([
    ["invalid input syntax (22P02)", withCode("22P02")],
    ["unique violation (23505)", withCode("23505")],
    ["undefined column (42703)", withCode("42703")],
    ["a plain bug", new TypeError("cannot read properties of undefined")],
  ])("treats %s as permanent", (_name, err) => {
    expect(isTransientDbError(err)).toBe(false);
  });
});

describe("isTransient / failureOf", () => {
  it("accepts TransientError and transient DB errors, rejects the rest", () => {
    expect(isTransient(new TransientError("HTTP 503", 503))).toBe(true);
    expect(isTransient(withCode("08006"))).toBe(true);
    expect(isTransient(withCode("22P02"))).toBe(false);
    expect(isTransient(new Error("bug"))).toBe(false);
  });

  it("extracts what to record on the page", () => {
    expect(failureOf(new TransientError("HTTP 503", 503))).toEqual({ httpStatus: 503, message: "HTTP 503" });
    expect(failureOf(new Error("db gone"))).toEqual({ httpStatus: null, message: "db gone" });
    expect(failureOf("weird")).toEqual({ httpStatus: null, message: "weird" });
  });
});
