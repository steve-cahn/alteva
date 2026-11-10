import { describe, expect, it } from "vitest";
import type { PageTreeNode } from "./api";
import { summarizeTree } from "./tree";

const node = (extra: Partial<PageTreeNode> = {}): PageTreeNode => ({
  id: "1",
  url: "https://s.test/",
  depth: 0,
  status: "done",
  domainLinkRatio: 1,
  outgoingCount: 1,
  children: [],
  ...extra,
});

describe("summarizeTree", () => {
  it("counts pages by outcome and adds up the links of the crawled ones", () => {
    const tree = node({
      outgoingCount: 5,
      domainLinkRatio: 0.8,
      children: [
        node({ outgoingCount: 3, domainLinkRatio: 1, children: [node({ outgoingCount: 2, domainLinkRatio: 0.5 })] }),
        node({ status: "skipped", outgoingCount: null, domainLinkRatio: null }),
        node({ status: "failed", outgoingCount: null, domainLinkRatio: null }),
        node({ status: "queued", outgoingCount: null, domainLinkRatio: null }),
      ],
    });
    expect(summarizeTree(tree)).toMatchObject({ pages: 6, crawled: 3, skipped: 1, failed: 1, links: 10 });
  });

  it("averages the ratio over crawled pages that have links", () => {
    const tree = node({ domainLinkRatio: 0.8, outgoingCount: 5, children: [node({ domainLinkRatio: 0.4, outgoingCount: 5 })] });
    expect(summarizeTree(tree).averageRatio).toBeCloseTo(0.6);
  });

  it("leaves a page with no links out of the average: its ratio of 0 is a definition, not a finding", () => {
    const tree = node({ domainLinkRatio: 1, outgoingCount: 4, children: [node({ domainLinkRatio: 0, outgoingCount: 0 })] });
    expect(summarizeTree(tree)).toMatchObject({ crawled: 2, averageRatio: 1 });
  });

  it("has no average when no crawled page has links", () => {
    expect(summarizeTree(node({ domainLinkRatio: 0, outgoingCount: 0 })).averageRatio).toBeNull();
    expect(summarizeTree(node({ status: "failed", domainLinkRatio: null, outgoingCount: null })).averageRatio).toBeNull();
  });
});
