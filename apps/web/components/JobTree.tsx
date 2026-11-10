"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { getJobTree, type PageTreeNode } from "@/lib/api";
import { formatRatio, pathOf } from "@/lib/format";
import { summarizeTree } from "@/lib/tree";
import { EmptyState, ErrorMessage } from "./Feedback";
import { ChevronIcon, CollapseIcon, ExpandIcon, LinkIcon, NetworkIcon } from "./Icons";
import { PageLinks } from "./PageLinks";
import { Button, Card, CardHeader, Skeleton } from "./ui";

type TreeState = { kind: "loading" } | { kind: "error"; error: Error } | { kind: "ready"; tree: PageTreeNode | null };

/** Fetches the finished job's page tree and renders it as a collapsible outline. */
export function JobTree({ jobId }: { jobId: string }) {
  const [state, setState] = useState<TreeState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    getJobTree(jobId, controller.signal).then(
      (res) => {
        if (!controller.signal.aborted) setState({ kind: "ready", tree: res.tree });
      },
      (error: Error) => {
        if (!controller.signal.aborted) setState({ kind: "error", error });
      },
    );
    return () => controller.abort();
  }, [jobId, attempt]);

  if (state.kind === "loading") {
    return (
      <Card role="status" aria-label="Loading pages" className="space-y-3 p-5">
        <Skeleton className="h-5 w-32" />
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </Card>
    );
  }
  if (state.kind === "error") {
    return (
      <ErrorMessage
        title="Could not load the page tree"
        error={state.error}
        onRetry={() => {
          setState({ kind: "loading" });
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  if (!state.tree) return <EmptyState title="No pages were recorded for this job" icon={<NetworkIcon size={22} />} />;

  const summary = summarizeTree(state.tree);
  const setAllOpen = (open: boolean) => listRef.current?.querySelectorAll("details").forEach((d) => (d.open = open));
  const rest = [summary.skipped && `${summary.skipped} skipped`, summary.failed && `${summary.failed} failed`].filter(Boolean).join(" · ");

  return (
    <Card>
      <CardHeader
        title="Pages"
        subtitle={rest ? `${summary.crawled} crawled · ${rest}` : `${summary.crawled} crawled`}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => setAllOpen(true)}>
              <ExpandIcon size={14} />
              Expand all
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAllOpen(false)}>
              <CollapseIcon size={14} />
              Collapse all
            </Button>
          </>
        }
      />
      <dl className="grid grid-cols-3 divide-x divide-line border-b border-line text-center">
        <Insight label="Pages crawled" value={String(summary.crawled)} />
        <Insight label="Links found" value={summary.links.toLocaleString()} />
        <Insight
          label="Avg. link ratio"
          value={summary.averageRatio === null ? "–" : formatRatio(summary.averageRatio)}
          title="Average Domain Link Ratio over the crawled pages that have links"
        />
      </dl>
      <ul ref={listRef} aria-label="Discovered pages" className="p-3 text-sm sm:p-4">
        <TreeNode node={state.tree} jobId={jobId} rootUrl={state.tree.url} />
      </ul>
    </Card>
  );
}

function Insight({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="px-3 py-4" title={title}>
      <dd className="text-xl font-semibold tabular-nums tracking-tight">{value}</dd>
      <dt className="mt-0.5 text-xs text-muted">{label}</dt>
    </div>
  );
}

const OPEN_TO_DEPTH = 2; // root and its children start expanded; deeper levels start collapsed

function TreeNode({ node, jobId, rootUrl }: { node: PageTreeNode; jobId: string; rootUrl: string }) {
  const [linksOpen, setLinksOpen] = useState(false);
  const isRoot = node.url === rootUrl;
  const row = <NodeRow node={node} label={isRoot ? node.url : pathOf(node.url)} linksOpen={linksOpen} onToggleLinks={() => setLinksOpen((open) => !open)} />;
  const links = linksOpen && <PageLinks jobId={jobId} pageId={node.id} />;

  if (node.children.length === 0) {
    return (
      <li>
        <div className="flex items-center gap-2 rounded-lg py-1.5 pl-6 pr-1 hover:bg-surface-2">{row}</div>
        {links}
      </li>
    );
  }
  return (
    <li>
      <details open={node.depth < OPEN_TO_DEPTH} className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg py-1.5 pr-1 hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
          <ChevronIcon size={16} className="shrink-0 text-faint transition-transform group-open:rotate-90" />
          {row}
        </summary>
        {links}
        <ul className="ml-[11px] border-l border-line pl-3">
          {node.children.map((child) => (
            <TreeNode key={child.url} node={child} jobId={jobId} rootUrl={rootUrl} />
          ))}
        </ul>
      </details>
    </li>
  );
}

const DOT: Record<string, string> = {
  done: "bg-success",
  skipped: "bg-warning",
  failed: "bg-danger",
  queued: "bg-faint",
};

function NodeRow({ node, label, linksOpen, onToggleLinks }: { node: PageTreeNode; label: string; linksOpen: boolean; onToggleLinks: () => void }) {
  const crawled = node.status === "done";
  const count = node.outgoingCount ?? 0;
  const hasLinks = crawled && count > 0;

  // The row can sit inside a <summary>, where a click would also fold the node: keep it to the button.
  const toggle = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onToggleLinks();
  };

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
      {/* The dot and the address stay together: a long URL wraps beside the dot, not under it. */}
      <span className="flex min-w-0 items-start gap-2.5">
        <span className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${DOT[node.status] ?? "bg-faint"}`} title={node.status} aria-hidden />
        <a
          href={node.url}
          target="_blank"
          rel="noopener noreferrer"
          title={node.url}
          className="min-w-0 font-medium [overflow-wrap:anywhere] transition-colors hover:text-primary-ink hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {label}
        </a>
      </span>
      <span className="ml-auto flex items-center gap-3">
        {crawled && count === 0 ? (
          // A ratio of 0% would read as "none of its links stay on the site", which is not what happened.
          <span
            className="text-xs text-faint"
            title="The HTML of this page contains no links. A site that builds its pages with JavaScript looks like this, because the crawler does not run scripts."
          >
            no links found
          </span>
        ) : crawled ? (
          <span className="flex items-center gap-2" title={`Domain Link Ratio: share of this page's ${count} links that stay on the site`}>
            <span aria-hidden className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-surface-2 sm:block">
              <span className="block h-full rounded-full bg-gradient-to-r from-primary to-sky-500" style={{ width: `${Math.round((node.domainLinkRatio ?? 0) * 100)}%` }} />
            </span>
            <span className="w-10 text-right text-xs font-semibold tabular-nums">{formatRatio(node.domainLinkRatio)}</span>
          </span>
        ) : (
          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-xs text-muted">{node.status}</span>
        )}
        {hasLinks && (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={linksOpen}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium tabular-nums transition-colors ${
              linksOpen ? "border-primary/40 bg-primary-soft text-primary-ink" : "border-line text-muted hover:border-line-strong hover:text-ink"
            }`}
          >
            <LinkIcon size={12} />
            {count} {count === 1 ? "link" : "links"}
          </button>
        )}
      </span>
    </div>
  );
}
