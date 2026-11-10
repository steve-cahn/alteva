import type { PageTreeNode } from "./api";

export interface TreeSummary {
  pages: number;
  crawled: number;
  skipped: number;
  failed: number;
  /** Outgoing links found across all crawled pages. */
  links: number;
  /** Mean Domain Link Ratio over the crawled pages that have links; null when there are none. */
  averageRatio: number | null;
}

/** Totals over a whole tree, for the summary above it. */
export function summarizeTree(root: PageTreeNode): TreeSummary {
  const summary: TreeSummary = { pages: 0, crawled: 0, skipped: 0, failed: 0, links: 0, averageRatio: null };
  let ratioSum = 0;
  let ratioCount = 0;
  const stack = [root];
  for (let node = stack.pop(); node; node = stack.pop()) {
    summary.pages++;
    if (node.status === "done") {
      summary.crawled++;
      summary.links += node.outgoingCount ?? 0;
      // A page with no links has ratio 0 by definition, which says nothing about the site: leave it out.
      if ((node.outgoingCount ?? 0) > 0 && node.domainLinkRatio !== null) {
        ratioSum += node.domainLinkRatio;
        ratioCount++;
      }
    } else if (node.status === "skipped") summary.skipped++;
    else if (node.status === "failed") summary.failed++;
    stack.push(...node.children);
  }
  if (ratioCount > 0) summary.averageRatio = ratioSum / ratioCount;
  return summary;
}
