"use client";

import { useEffect, useMemo, useState } from "react";
import { getPageLinks, type PageLinksResponse } from "@/lib/api";
import { ErrorMessage } from "./Feedback";
import { ExternalIcon } from "./Icons";
import { Skeleton } from "./ui";

type State = { kind: "loading" } | { kind: "error"; error: Error } | { kind: "ready"; data: PageLinksResponse };
type Filter = "all" | "internal" | "external";

/** A stable empty list, so memoized values do not change on every render while loading. */
const NO_LINKS: PageLinksResponse["links"] = [];

/** The outgoing links of one crawled page, fetched when the panel opens. */
export function PageLinks({ jobId, pageId }: { jobId: string; pageId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    const controller = new AbortController();
    getPageLinks(jobId, pageId, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ kind: "ready", data });
      },
      (error: Error) => {
        if (!controller.signal.aborted) setState({ kind: "error", error });
      },
    );
    return () => controller.abort();
  }, [jobId, pageId, attempt]);

  const links = state.kind === "ready" ? state.data.links : NO_LINKS;
  const counts = useMemo(() => {
    const internal = links.filter((l) => l.isInternal).length;
    return { all: links.length, internal, external: links.length - internal };
  }, [links]);

  const panel = "my-2 ml-6 rounded-xl border border-line bg-surface-2/60 p-3";

  if (state.kind === "loading") {
    return (
      <div role="status" aria-label="Loading links" className={`${panel} space-y-2`}>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-6" />
        <Skeleton className="h-6" />
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className={panel}>
        <ErrorMessage
          title="Could not load this page's links"
          error={state.error}
          onRetry={() => {
            setState({ kind: "loading" });
            setAttempt((n) => n + 1);
          }}
        />
      </div>
    );
  }

  const { total, truncated } = state.data;
  if (links.length === 0) return <p className={`${panel} text-sm text-muted`}>This page has no links</p>;
  const shown = filter === "all" ? links : links.filter((l) => (filter === "internal" ? l.isInternal : !l.isInternal));

  return (
    <div className={`${panel} text-xs`}>
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted">
          {total} {total === 1 ? "link" : "links"}
          {truncated ? `, first ${links.length} shown` : `: ${counts.internal} internal, ${counts.external} external`}
        </p>
        <div role="group" aria-label="Filter links" className="inline-flex rounded-lg border border-line bg-surface p-0.5">
          {(["all", "internal", "external"] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`rounded-md px-2.5 py-1 font-medium capitalize transition-colors ${
                filter === f ? "bg-primary-soft text-primary-ink" : "text-muted hover:text-ink"
              }`}
            >
              {f} <span className="tabular-nums opacity-70">{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>
      <ul className="max-h-72 space-y-0.5 overflow-y-auto pr-1">
        {shown.map((link) => (
          <li key={link.url} className="flex items-baseline gap-2.5 rounded-md px-1.5 py-1 hover:bg-surface">
            <span
              className={`w-14 shrink-0 rounded-md px-1.5 py-0.5 text-center text-[11px] font-medium ${
                link.isInternal ? "bg-success-soft text-success" : "bg-surface text-muted ring-1 ring-inset ring-line"
              }`}
            >
              {link.isInternal ? "internal" : "external"}
            </span>
            <a href={link.url} target="_blank" rel="noopener noreferrer" className="group/link inline-flex min-w-0 items-baseline gap-1 [overflow-wrap:anywhere] text-ink/85 hover:text-primary-ink hover:underline">
              {link.url}
              <ExternalIcon size={11} className="hidden shrink-0 self-center opacity-60 group-hover/link:block" />
            </a>
          </li>
        ))}
        {shown.length === 0 && <li className="px-1.5 py-1 text-muted">No {filter} links</li>}
      </ul>
    </div>
  );
}
