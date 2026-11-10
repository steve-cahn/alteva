import { describe, expectTypeOf, it, expect } from "vitest";
import type { PageTaskMessage } from "../src";

describe("PageTaskMessage", () => {
  it("has the fields the worker needs, with a nullable parent for the start page", () => {
    expectTypeOf<PageTaskMessage>().toEqualTypeOf<{
      messageId: string;
      jobId: string;
      url: string;
      depth: number;
      parentPageId: number | null;
      correlationId: string;
    }>();
  });

  it("round-trips through JSON, which is how it travels over the broker", () => {
    const msg: PageTaskMessage = {
      messageId: "m1",
      jobId: "j1",
      url: "https://site.com/",
      depth: 0,
      parentPageId: null,
      correlationId: "c1",
    };
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });
});
