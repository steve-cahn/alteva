import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors";
import { encodeCursor, parseCreateJob, parseJobId, parseListQuery } from "../src/validation";

const fieldsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).statusCode).toBe(400);
    return (err as ApiError).details!.map((d) => d.field);
  }
  throw new Error("expected a validation error");
};

describe("parseCreateJob", () => {
  it("accepts an http(s) URL, normalizes it and defaults maxDepth", () => {
    expect(parseCreateJob({ url: "HTTPS://Example.com:443/a/#top" }, 2, 200)).toEqual({
      url: "https://example.com/a",
      startHost: "example.com",
      maxDepth: 2,
    });
    expect(parseCreateJob({ url: "http://example.com" }, 3, 200).maxDepth).toBe(3);
  });

  it("keeps the www host as typed", () => {
    expect(parseCreateJob({ url: "https://www.example.com" }, 2, 200).startHost).toBe("www.example.com");
  });

  it.each([0, 1, 3, 5, 50, 200])("accepts maxDepth %i, from 0 (the start page only) up to the page limit", (maxDepth) => {
    expect(parseCreateJob({ url: "https://a.com", maxDepth }, 2, 200).maxDepth).toBe(maxDepth);
  });

  it("uses the default depth when none is given, including a default of 0", () => {
    expect(parseCreateJob({ url: "https://a.com" }, 0, 200).maxDepth).toBe(0);
  });

  it("takes the ceiling from the page limit, since no crawl can go deeper than it has pages", () => {
    expect(parseCreateJob({ url: "https://a.com", maxDepth: 50 }, 2, 50).maxDepth).toBe(50);
    expect(fieldsOf(() => parseCreateJob({ url: "https://a.com", maxDepth: 51 }, 2, 50))).toEqual(["maxDepth"]);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["not a string", 42],
    ["null", null],
    ["a bare host", "example.com"],
    ["relative", "/a/b"],
    ["ftp", "ftp://example.com/file"],
    ["javascript:", "javascript:alert(1)"],
    ["mailto:", "mailto:a@b.com"],
    ["file:", "file:///etc/passwd"],
    ["data:", "data:text/html,hi"],
    ["too long", `https://example.com/${"a".repeat(2048)}`],
  ])("rejects a %s url", (_name, url) => {
    expect(fieldsOf(() => parseCreateJob({ url }, 2, 200))).toEqual(["url"]);
  });

  it.each([-1, 201, 2.5, "2", null, NaN, Infinity, 1e308, 2 ** 31])("rejects maxDepth %o", (maxDepth) => {
    expect(fieldsOf(() => parseCreateJob({ url: "https://a.com", maxDepth }, 2, 200))).toEqual(["maxDepth"]);
  });

  it("says what is allowed", () => {
    try {
      parseCreateJob({ url: "https://a.com", maxDepth: -3 }, 2, 200);
      throw new Error("expected a validation error");
    } catch (err) {
      expect((err as ApiError).details).toEqual([{ field: "maxDepth", message: "must be a whole number from 0 to 200" }]);
    }
  });

  it("reports every problem at once", () => {
    expect(fieldsOf(() => parseCreateJob({ url: "nope", maxDepth: 999 }, 2, 200))).toEqual(["url", "maxDepth"]);
  });

  it.each([[null], ["text"], [42], [[]]])("rejects a non-object body %o", (body) => {
    expect(fieldsOf(() => parseCreateJob(body, 2, 200))).toContain("url");
  });
});

describe("parseJobId", () => {
  it("accepts a UUID in any case and returns it lowercased", () => {
    expect(parseJobId("0B070945-9FC2-45F9-93B7-B0BE2819E269")).toBe("0b070945-9fc2-45f9-93b7-b0be2819e269");
  });

  it.each(["", "abc", "123", "0b070945-9fc2-45f9-93b7-b0be2819e26", "0b070945-9fc2-45f9-93b7-b0be2819e269x", "'; drop table jobs;--"])(
    "rejects %j",
    (id) => expect(fieldsOf(() => parseJobId(id))).toEqual(["id"]),
  );
});

describe("parseListQuery", () => {
  const cursor = { createdAt: "2026-11-10 18:01:41.120908+00", id: "0b070945-9fc2-45f9-93b7-b0be2819e269" };

  it("defaults to 20 items, no cursor and no status filter", () => {
    expect(parseListQuery({})).toEqual({ limit: 20, cursor: null, statuses: null });
    expect(parseListQuery(undefined)).toEqual({ limit: 20, cursor: null, statuses: null });
  });

  it("accepts limits 1 to 100", () => {
    expect(parseListQuery({ limit: "1" }).limit).toBe(1);
    expect(parseListQuery({ limit: "100" }).limit).toBe(100);
  });

  it.each(["0", "101", "-1", "2.5", "abc", "", "1e2", "10 "])("rejects limit %j", (limit) => {
    expect(fieldsOf(() => parseListQuery({ limit }))).toEqual(["limit"]);
  });

  it("round-trips a cursor and treats an empty cursor as none", () => {
    expect(parseListQuery({ cursor: encodeCursor(cursor) }).cursor).toEqual(cursor);
    expect(parseListQuery({ cursor: "" }).cursor).toBeNull();
  });

  it.each([
    ["garbage", "!!!"],
    ["not JSON", Buffer.from("nope").toString("base64url")],
    ["wrong shape", Buffer.from(JSON.stringify({ a: 1 })).toString("base64url")],
    ["bad timestamp", Buffer.from(JSON.stringify(["yesterday", cursor.id])).toString("base64url")],
    ["bad id", Buffer.from(JSON.stringify([cursor.createdAt, "123"])).toString("base64url")],
    ["SQL in the timestamp", Buffer.from(JSON.stringify(["2026-01-01'; DROP TABLE jobs;--", cursor.id])).toString("base64url")],
  ])("rejects a cursor that is %s", (_name, bad) => {
    expect(fieldsOf(() => parseListQuery({ cursor: bad }))).toEqual(["cursor"]);
  });
});

describe("parseListQuery: status filter", () => {
  const statuses = (status: unknown) => parseListQuery({ status }).statuses;

  it("accepts one status, a comma list, and a repeated parameter", () => {
    expect(statuses("Failed")).toEqual(["Failed"]);
    expect(statuses("Pending,Running")).toEqual(["Pending", "Running"]);
    expect(statuses(["Pending", "Running"])).toEqual(["Pending", "Running"]);
    expect(statuses(["Pending,Running", "Failed"])).toEqual(["Pending", "Running", "Failed"]);
  });

  it("tolerates spaces and repeats", () => {
    expect(statuses(" Failed , Canceled ")).toEqual(["Failed", "Canceled"]);
    expect(statuses("Failed,Failed")).toEqual(["Failed"]);
  });

  it.each([[undefined], [""], [","], [" "], [[]]])("treats %j as no filter", (value) => {
    expect(statuses(value)).toBeNull();
  });

  it.each([["failed"], ["COMPLETED"], ["Done"], ["Failed,Bogus"], ["Pending;Running"], ["'; DROP TABLE jobs;--"], [["Failed", "nope"]], [42]])(
    "rejects %j: names are exact, and a bad one is an error, not silently ignored",
    (value) => {
      expect(fieldsOf(() => parseListQuery({ status: value }))).toEqual(["status"]);
    },
  );

  it("reports a bad status together with other problems", () => {
    expect(fieldsOf(() => parseListQuery({ status: "nope", limit: "0" }))).toEqual(["limit", "status"]);
  });
});
