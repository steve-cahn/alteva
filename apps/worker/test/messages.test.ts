import { describe, expect, it } from "vitest";
import { parsePageTask } from "../src/messages";

const valid = { messageId: "m", jobId: "j", url: "https://s.com/", depth: 1, parentPageId: 7, correlationId: "c" };
const parse = (value: unknown) => parsePageTask(Buffer.from(typeof value === "string" ? value : JSON.stringify(value)));

describe("parsePageTask", () => {
  it("accepts a valid task, with a null or numeric parent", () => {
    expect(parse(valid)).toEqual(valid);
    expect(parse({ ...valid, parentPageId: null }).parentPageId).toBeNull();
  });

  it.each([
    ["invalid JSON", "{nope"],
    ["a non-object", "42"],
    ["null", "null"],
    ["a missing jobId", { ...valid, jobId: undefined }],
    ["an empty url", { ...valid, url: "" }],
    ["a negative depth", { ...valid, depth: -1 }],
    ["a fractional depth", { ...valid, depth: 1.5 }],
    ["a string depth", { ...valid, depth: "1" }],
    ["a missing parentPageId", { ...valid, parentPageId: undefined }],
    ["a string parentPageId", { ...valid, parentPageId: "7" }],
  ])("rejects %s", (_name, payload) => {
    expect(() => parse(payload)).toThrow();
  });
});
