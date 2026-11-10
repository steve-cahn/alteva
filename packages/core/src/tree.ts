export interface PageTreeRow {
  id: string;
  /** Null for the root page. */
  parentId: string | null;
  url: string;
  depth: number;
  status: string;
  domainLinkRatio: number | null;
  outgoingCount: number | null;
}

export interface PageTreeNode {
  /** The page row id, which the page-links endpoint takes. */
  id: string;
  url: string;
  depth: number;
  status: string;
  domainLinkRatio: number | null;
  outgoingCount: number | null;
  children: PageTreeNode[];
}

/**
 * Nests pages by parent id. Siblings keep the order of `rows`. Returns null when there is no
 * root row. Rows whose parent is missing are left out rather than guessed at.
 */
export function buildPageTree(rows: PageTreeRow[]): PageTreeNode | null {
  const nodes = new Map<string, PageTreeNode>();
  for (const row of rows) nodes.set(row.id, toNode(row));

  let root: PageTreeNode | null = null;
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    if (row.parentId === null) root ??= node;
    else nodes.get(row.parentId)?.children.push(node);
  }
  return root;
}

function toNode(row: PageTreeRow): PageTreeNode {
  return {
    id: row.id,
    url: row.url,
    depth: row.depth,
    status: row.status,
    domainLinkRatio: row.domainLinkRatio,
    outgoingCount: row.outgoingCount,
    children: [],
  };
}
