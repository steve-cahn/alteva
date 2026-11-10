import { describe, expect, it } from "vitest";
import { buildPageTree, type PageTreeRow } from "../src";

const row = (id: string, parentId: string | null, url: string, extra: Partial<PageTreeRow> = {}): PageTreeRow => ({
  id,
  parentId,
  url,
  depth: parentId === null ? 0 : 1,
  status: "done",
  domainLinkRatio: 0.5,
  outgoingCount: 4,
  ...extra,
});

describe("buildPageTree", () => {
  it("nests pages under their parent and keeps sibling order", () => {
    const tree = buildPageTree([
      row("1", null, "/"),
      row("2", "1", "/a"),
      row("3", "1", "/b"),
      row("4", "2", "/c", { depth: 2 }),
    ]);
    expect(tree?.url).toBe("/");
    expect(tree?.children.map((c) => c.url)).toEqual(["/a", "/b"]);
    expect(tree?.children[0].children.map((c) => c.url)).toEqual(["/c"]);
    expect(tree?.children[1].children).toEqual([]);
  });

  it("carries url, depth, status, ratio and outgoing count on every node", () => {
    const tree = buildPageTree([row("1", null, "/"), row("2", "1", "/x", { status: "failed", domainLinkRatio: null, outgoingCount: null })]);
    expect(tree).toEqual({
      id: "1",
      url: "/",
      depth: 0,
      status: "done",
      domainLinkRatio: 0.5,
      outgoingCount: 4,
      children: [{ id: "2", url: "/x", depth: 1, status: "failed", domainLinkRatio: null, outgoingCount: null, children: [] }],
    });
  });

  it("builds a partial tree while the crawl is still running", () => {
    const tree = buildPageTree([row("1", null, "/"), row("2", "1", "/a", { status: "queued", domainLinkRatio: null, outgoingCount: null })]);
    expect(tree?.children[0]).toMatchObject({ status: "queued", domainLinkRatio: null });
  });

  it("handles a child listed before its parent", () => {
    const tree = buildPageTree([row("2", "1", "/a"), row("1", null, "/")]);
    expect(tree?.children.map((c) => c.url)).toEqual(["/a"]);
  });

  it("leaves out pages whose parent is missing", () => {
    const tree = buildPageTree([row("1", null, "/"), row("9", "404", "/orphan")]);
    expect(tree?.children).toEqual([]);
  });

  it("returns null when there is no root page", () => {
    expect(buildPageTree([])).toBeNull();
    expect(buildPageTree([row("2", "1", "/a")])).toBeNull();
  });
});
