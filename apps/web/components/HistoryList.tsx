"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getJobCounts, listJobs, type Job, type JobCounts, type JobStatus } from "@/lib/api";
import { formatDateTime, formatDuration, formatShortDateTime, hostOf, jobDurationMs, timeAgo } from "@/lib/format";
import { EmptyState, ErrorMessage } from "./Feedback";
import { ArrowRightIcon, ClockIcon, InboxIcon, LayersIcon, RefreshIcon, SearchIcon } from "./Icons";
import { StatusBadge } from "./StatusBadge";
import { Button, buttonStyles, Card, Skeleton } from "./ui";

type FilterId = "all" | "completed" | "active" | "failed" | "canceled";

/** Each chip maps to the statuses the server is asked for; "all" sends none. */
const FILTERS: Array<{ id: FilterId; label: string; statuses?: JobStatus[] }> = [
  { id: "all", label: "All" },
  { id: "completed", label: "Completed", statuses: ["Completed"] },
  { id: "active", label: "In progress", statuses: ["Pending", "Running"] },
  { id: "failed", label: "Failed", statuses: ["Failed"] },
  { id: "canceled", label: "Canceled", statuses: ["Canceled"] },
];

const countFor = (filter: (typeof FILTERS)[number], counts: JobCounts) =>
  filter.statuses ? filter.statuses.reduce((sum, status) => sum + counts.byStatus[status], 0) : counts.total;

/** The list for one filter. It remembers which filter it belongs to, so a late answer for another one is ignored. */
type ListState =
  | { kind: "loading" }
  | { kind: "error"; error: Error }
  | { kind: "ready"; filter: FilterId; items: Job[]; nextCursor: string | null };

export function HistoryList() {
  const [filter, setFilter] = useState<FilterId>("all");
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [counts, setCounts] = useState<JobCounts | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  const active = FILTERS.find((f) => f.id === filter) ?? FILTERS[0];

  // The first page for the chosen filter. Changing the filter or refreshing starts a new request, and
  // the old one is aborted so its answer can never overwrite a newer one.
  useEffect(() => {
    const controller = new AbortController();
    listJobs({ status: active.statuses, signal: controller.signal }).then(
      (page) => {
        if (controller.signal.aborted) return; // the user has moved on: this answer is stale
        setList({ kind: "ready", filter, ...page });
        setHasLoaded(true);
      },
      (error: Error) => {
        if (!controller.signal.aborted) setList({ kind: "error", error });
      },
    );
    return () => controller.abort();
  }, [filter, attempt, active.statuses]);

  // Totals for the chips. They describe the whole history, so they do not depend on the filter, and
  // if they cannot be had the list still works (the chips just show no numbers).
  useEffect(() => {
    const controller = new AbortController();
    getJobCounts(controller.signal).then(
      (fresh) => {
        if (!controller.signal.aborted) setCounts(fresh);
      },
      () => {
        if (!controller.signal.aborted) setCounts(null);
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const selectFilter = useCallback((next: FilterId) => {
    setFilter(next);
    setList({ kind: "loading" });
    setMoreError(null);
  }, []);

  const reload = useCallback(() => {
    setList({ kind: "loading" });
    setMoreError(null);
    setAttempt((n) => n + 1);
  }, []);

  async function loadMore() {
    if (list.kind !== "ready" || !list.nextCursor) return;
    const { filter: requested, items, nextCursor } = list;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await listJobs({ cursor: nextCursor, status: active.statuses });
      // Only if the user is still looking at the list this page belongs to.
      setList((current) => (current.kind === "ready" && current.filter === requested ? { kind: "ready", filter: requested, items: [...items, ...page.items], nextCursor: page.nextCursor } : current));
    } catch (err) {
      setMoreError(err as Error);
    } finally {
      setLoadingMore(false);
    }
  }

  if (!hasLoaded) {
    if (list.kind === "error") return <ErrorMessage title="Could not load history" error={list.error} onRetry={reload} />;
    return <HistorySkeleton />;
  }

  const nothingAtAll = counts?.total === 0 || (filter === "all" && list.kind === "ready" && list.items.length === 0);
  if (nothingAtAll && list.kind === "ready") {
    return (
      <EmptyState title="No crawls yet" icon={<InboxIcon size={22} />}>
        Your crawls will show up here.
        <div className="mt-4">
          <Link href="/" className={buttonStyles("primary")}>
            Start your first crawl
            <ArrowRightIcon size={16} />
          </Link>
        </div>
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-2">
          {FILTERS.filter((f) => f.id === "all" || f.id === filter || !counts || countFor(f, counts) > 0).map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => selectFilter(f.id)}
              className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                filter === f.id ? "border-primary/40 bg-primary-soft text-primary-ink" : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink"
              }`}
            >
              {f.label} {counts && <span className="tabular-nums opacity-70">{countFor(f, counts)}</span>}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={reload}>
          <RefreshIcon size={14} />
          Refresh
        </Button>
      </div>

      {list.kind === "loading" && <RowsSkeleton />}
      {list.kind === "error" && <ErrorMessage title="Could not load history" error={list.error} onRetry={reload} />}
      {list.kind === "ready" && <Results list={list} label={active.label} loadMore={loadMore} loadingMore={loadingMore} moreError={moreError} />}
    </div>
  );
}

function Results({
  list,
  label,
  loadMore,
  loadingMore,
  moreError,
}: {
  list: Extract<ListState, { kind: "ready" }>;
  label: string;
  loadMore: () => void;
  loadingMore: boolean;
  moreError: Error | null;
}) {
  if (list.items.length === 0) {
    return (
      <EmptyState title={`No ${label.toLowerCase()} crawls`} icon={<SearchIcon size={22} />}>
        None in your history.
      </EmptyState>
    );
  }
  return (
    <>
      <Card className="overflow-hidden">
        <ColumnHeaders />
        <ul aria-label="Previous crawl jobs, newest first" className="divide-y divide-line">
          {list.items.map((job) => (
            <li key={job.id}>
              <JobRow job={job} />
            </li>
          ))}
        </ul>
      </Card>

      {moreError && <ErrorMessage title="Could not load more" error={moreError} onRetry={loadMore} />}
      <div className="flex justify-center pt-1">
        {list.nextCursor ? (
          <Button variant="secondary" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        ) : (
          <p className="text-sm text-faint">
            That&apos;s everything: {list.items.length} {list.items.length === 1 ? "crawl" : "crawls"}
          </p>
        )}
      </div>
    </>
  );
}

/** Column widths, shared by the header and every row so they line up. */
const COL = {
  status: "sm:w-28",
  pages: "sm:w-24",
  duration: "sm:w-20",
  created: "sm:w-36",
  finished: "sm:w-36",
};

function ColumnHeaders() {
  return (
    <div aria-hidden className="hidden items-center gap-5 border-b border-line bg-surface-2/60 px-5 py-2.5 text-xs font-medium text-muted sm:flex">
      <span className="w-10 shrink-0" />
      <span className="min-w-0 flex-1">Site</span>
      <span className="flex items-center gap-x-4">
        <span className={COL.status}>Status</span>
        <span className={COL.pages}>Pages</span>
        <span className={COL.duration}>Duration</span>
        <span className={COL.created}>Created</span>
        <span className={COL.finished}>Finished</span>
      </span>
      <span className="w-4 shrink-0" />
    </div>
  );
}

function JobRow({ job }: { job: Job }) {
  const host = hostOf(job.url);
  const duration = jobDurationMs(job);
  return (
    <Link href={`/jobs/${job.id}`} className="group flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-5">
      <span aria-hidden className="hidden h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-sm font-semibold uppercase text-primary-ink sm:grid">
        {host.replace(/^www\./, "").charAt(0)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold tracking-tight">{host}</p>
        <p className="truncate text-sm text-muted" title={job.url}>
          {job.url}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted sm:flex-nowrap sm:gap-x-4">
        <span className={COL.status}>
          <StatusBadge status={job.status} />
        </span>
        <span className={`inline-flex items-center gap-1.5 tabular-nums ${COL.pages}`} title="Pages processed">
          <LayersIcon size={14} className="text-faint" />
          {job.progress.pagesProcessed} {job.progress.pagesProcessed === 1 ? "page" : "pages"}
        </span>
        <span className={`inline-flex items-center gap-1.5 tabular-nums ${COL.duration}`} title="How long it took">
          {duration !== null && duration > 0 && job.completedAt && (
            <>
              <ClockIcon size={14} className="text-faint" />
              {formatDuration(duration)}
            </>
          )}
        </span>
        <span className={`tabular-nums ${COL.created}`}>
          <span className="text-faint sm:hidden">Created </span>
          <time dateTime={job.createdAt} title={formatDateTime(job.createdAt)} className="text-ink">
            {formatShortDateTime(job.createdAt)}
          </time>
          <span className="hidden text-xs text-faint sm:block">{timeAgo(job.createdAt)}</span>
        </span>
        <span className={`tabular-nums ${COL.finished}`}>
          <span className="text-faint sm:hidden">Finished </span>
          {job.completedAt ? (
            <time dateTime={job.completedAt} title={formatDateTime(job.completedAt)} className="text-ink">
              {formatShortDateTime(job.completedAt)}
            </time>
          ) : (
            <span aria-label="not finished yet">–</span>
          )}
        </span>
      </div>
      <ArrowRightIcon size={16} className="hidden shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink sm:block" />
    </Link>
  );
}

function RowsSkeleton() {
  return (
    <Card role="status" aria-label="Loading crawls" className="divide-y divide-line overflow-hidden">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-5 px-5 py-4">
          <Skeleton className="hidden h-10 w-10 rounded-xl sm:block" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3.5 w-72 max-w-full" />
          </div>
          <Skeleton className="h-6 w-24 rounded-full" />
        </div>
      ))}
    </Card>
  );
}

function HistorySkeleton() {
  return (
    <div role="status" aria-label="Loading history" className="space-y-4">
      <div className="flex gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-9 w-24 rounded-full" />
        ))}
      </div>
      <RowsSkeleton />
    </div>
  );
}
