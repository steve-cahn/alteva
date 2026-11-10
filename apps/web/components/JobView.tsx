"use client";

import Link from "next/link";
import { use, useState, type ReactNode } from "react";
import { ApiRequestError, cancelJob, type Job, type PageCounts } from "@/lib/api";
import { formatDateTime, formatDuration, hostOf, isCancelable, jobDurationMs, progressPercent } from "@/lib/format";
import { useJob } from "@/lib/useJob";
import { useNow } from "@/lib/useNow";
import { CopyButton } from "./CopyButton";
import { EmptyState, ErrorMessage } from "./Feedback";
import { AlertIcon, ArrowLeftIcon, ClockIcon, ExternalIcon, LayersIcon, NetworkIcon, XIcon } from "./Icons";
import { JobTree } from "./JobTree";
import { StatusBadge } from "./StatusBadge";
import { Button, buttonStyles, Card, Skeleton } from "./ui";

/** The route hands over `params` as a promise; `use` unwraps it (the page wraps this in Suspense). */
export function JobView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { state, retry, update } = useJob(id);

  if (state.kind === "loading") return <JobSkeleton />;
  if (state.kind === "error") {
    if (state.error instanceof ApiRequestError && state.error.isNotFound) {
      return (
        <EmptyState title="Job not found" icon={<AlertIcon size={22} />}>
          This job does not exist or the link is wrong.{" "}
          <Link href="/history" className="font-medium text-primary-ink underline underline-offset-2">
            See recent jobs
          </Link>
        </EmptyState>
      );
    }
    return <ErrorMessage title="Could not load this job" error={state.error} onRetry={retry} />;
  }
  return <JobDetails job={state.job} pollError={state.pollError} onUpdate={update} />;
}

/** Holds the page's place while the job loads, so nothing jumps when it arrives. */
export function JobSkeleton() {
  return (
    <div role="status" aria-label="Loading job" className="space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-44 rounded-2xl" />
      <Skeleton className="h-64 rounded-2xl" />
    </div>
  );
}

export function JobDetails({ job, pollError, onUpdate }: { job: Job; pollError: string | null; onUpdate: (job: Job) => void }) {
  const active = isCancelable(job.status);
  const now = useNow(job.status === "Running");
  const duration = jobDurationMs(job, now);
  const done = job.status === "Completed";
  const { pagesDiscovered, pagesProcessed } = job.progress;

  return (
    <div className="animate-fade-up space-y-6">
      <header>
        <Link href="/history" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink">
          <ArrowLeftIcon size={14} />
          History
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="break-all text-3xl font-semibold tracking-tight">{hostOf(job.url)}</h1>
              <StatusBadge status={job.status} size="lg" />
            </div>
            <a
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-flex max-w-full items-center gap-1.5 break-all text-sm text-muted transition-colors hover:text-primary-ink"
            >
              {job.url}
              <ExternalIcon size={13} className="shrink-0" />
            </a>
            <p className="mt-2 flex items-center gap-1.5 font-mono text-xs text-faint">
              <span>{job.id}</span>
              <CopyButton value={job.id} label="Copy job id" />
            </p>
          </div>
          {active ? (
            <CancelButton jobId={job.id} onCanceled={onUpdate} />
          ) : (
            <Link href="/" className={buttonStyles("secondary")}>
              New crawl
            </Link>
          )}
        </div>
      </header>

      {pollError && (
        <p role="status" className="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">
          <AlertIcon size={16} />
          Lost contact with the API, still trying: {pollError}
        </p>
      )}

      {job.failureReason && (
        <div role="alert" className="flex gap-3 rounded-2xl border border-danger/30 bg-danger-soft p-4">
          <span className="mt-0.5 text-danger">
            <AlertIcon size={20} />
          </span>
          <div>
            <p className="font-semibold text-danger">This crawl failed</p>
            <p className="mt-1 text-sm text-ink/80">Failure reason: {job.failureReason}</p>
          </div>
        </div>
      )}

      <section aria-label="Summary" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat icon={<LayersIcon size={16} />} label="Pages found" value={pagesDiscovered} />
        <Stat icon={<NetworkIcon size={16} />} label="Pages processed" value={pagesProcessed} sub={`of ${pagesDiscovered}`} />
        <Stat icon={<ClockIcon size={16} />} label="Duration" value={duration === null ? "–" : formatDuration(duration)} sub={job.status === "Running" ? "so far" : undefined} />
        <Stat icon={<LayersIcon size={16} />} label="Max depth" value={job.maxDepth} sub={`up to ${job.maxPages} pages`} />
      </section>

      <Card aria-label="Progress" className="p-5 sm:p-6">
        {/* With a status breakdown, that stacked bar is the progress bar: two bars would say the same thing twice. */}
        <Progress job={job} done={done} showBar={!job.pageCounts} />
        {job.pageCounts && <PageCountsBar counts={job.pageCounts} job={job} />}
        <Timeline job={job} />
      </Card>

      <section aria-label="Results">
        <Results job={job} />
      </section>
    </div>
  );
}

function Stat({ icon, label, value, sub }: { icon: ReactNode; label: string; value: ReactNode; sub?: string }) {
  return (
    <Card className="p-4">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
        <span className="text-faint">{icon}</span>
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      <p className="mt-0.5 h-4 text-xs text-faint">{sub}</p>
    </Card>
  );
}

function Progress({ job, done, showBar }: { job: Job; done: boolean; showBar: boolean }) {
  const { pagesProcessed, pagesDiscovered } = job.progress;
  const percent = done ? 100 : progressPercent(pagesProcessed, pagesDiscovered);
  const running = job.status === "Running";
  const stopped = job.status === "Failed" || job.status === "Canceled";
  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Progress</h2>
          <p className="mt-0.5 text-sm text-muted">
            {pagesProcessed} of {pagesDiscovered} pages processed ({percent}%)
          </p>
        </div>
        <p className="text-3xl font-semibold tabular-nums tracking-tight">
          {percent}
          <span className="text-lg text-muted">%</span>
        </p>
      </div>
      {showBar && (
        <div
          role="progressbar"
          aria-label="Pages processed"
          aria-valuemin={0}
          aria-valuemax={pagesDiscovered}
          aria-valuenow={pagesProcessed}
          className="mt-4 h-3 w-full overflow-hidden rounded-full bg-surface-2"
        >
          <div
            className={`h-full rounded-full transition-[width] duration-500 ease-out ${
              stopped ? "bg-faint" : done ? "bg-success" : "bg-gradient-to-r from-primary to-sky-500"
            } ${running ? "animate-shimmer bg-[length:200%_100%]" : ""}`}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </div>
  );
}

const SEGMENTS = [
  { key: "done", label: "done", bar: "bg-success", dot: "bg-success" },
  { key: "queued", label: "queued", bar: "bg-info/40", dot: "bg-info/60" },
  { key: "skipped", label: "skipped", bar: "bg-warning", dot: "bg-warning" },
  { key: "failed", label: "failed", bar: "bg-danger", dot: "bg-danger" },
] as const;

/**
 * Pages by status as one stacked bar with a legend ("74 done · 2 failed"). For a job still going it
 * is the progress bar: done grows, queued shimmers.
 */
function PageCountsBar({ counts, job }: { counts: PageCounts; job: Job }) {
  const total = counts.done + counts.queued + counts.skipped + counts.failed;
  if (total === 0) return null;
  const present = SEGMENTS.filter(({ key }) => counts[key] > 0);
  const live = isCancelable(job.status);
  const running = job.status === "Running";
  const { pagesProcessed, pagesDiscovered } = job.progress;
  return (
    <div className="mt-5">
      <div
        {...(live
          ? { role: "progressbar", "aria-label": "Pages processed", "aria-valuemin": 0, "aria-valuemax": pagesDiscovered, "aria-valuenow": pagesProcessed }
          : { "aria-hidden": true })}
        className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-surface-2"
      >
        {present.map(({ key, bar }) => (
          <div
            key={key}
            className={`${key === "queued" && running ? "animate-shimmer bg-gradient-to-r from-info/25 via-info/60 to-info/25" : bar} transition-[width] duration-500 ease-out first:rounded-l-full last:rounded-r-full`}
            style={{ width: `${(counts[key] / total) * 100}%` }}
          />
        ))}
      </div>
      <ul aria-label="Pages by status" className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-muted">
        {present.map(({ key, label, dot }) => (
          <li key={key} className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
            <span>
              <span className="font-medium tabular-nums text-ink">{counts[key]}</span> {label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Created, started, finished: three moments on a line. */
function Timeline({ job }: { job: Job }) {
  const steps = [
    { label: "Created", at: job.createdAt },
    { label: "Started", at: job.startedAt },
    { label: job.status === "Canceled" ? "Canceled" : job.status === "Failed" ? "Failed" : "Finished", at: job.completedAt },
  ];
  return (
    <dl className="mt-6 grid gap-4 border-t border-line pt-5 sm:grid-cols-3">
      {steps.map(({ label, at }) => (
        <div key={label} className="flex items-start gap-3">
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${at ? "bg-primary" : "bg-line-strong"}`} aria-hidden />
          <div>
            <dt className="text-xs font-medium text-muted">{label}</dt>
            <dd className="mt-0.5 text-sm tabular-nums">{formatDateTime(at)}</dd>
          </div>
        </div>
      ))}
    </dl>
  );
}

function Results({ job }: { job: Job }) {
  if (job.status === "Completed") return <JobTree jobId={job.id} />;
  if (job.status === "Canceled") return <EmptyState title="This job was canceled">No results are shown for canceled jobs.</EmptyState>;
  if (job.status === "Failed") return <EmptyState title="This job failed" icon={<AlertIcon size={22} />}>No results are available.</EmptyState>;
  return <EmptyState title="The page tree appears here when the crawl finishes" icon={<NetworkIcon size={22} />}>Progress updates every moment.</EmptyState>;
}

function CancelButton({ jobId, onCanceled }: { jobId: string; onCanceled: (job: Job) => void }) {
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function cancel() {
    setCanceling(true);
    setError(null);
    try {
      onCanceled(await cancelJob(jobId));
    } catch (err) {
      setError(err as Error);
      setCanceling(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button onClick={cancel} disabled={canceling} variant="danger">
        <XIcon size={15} />
        {canceling ? "Canceling…" : "Cancel crawl"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          Could not cancel: {error.message}
        </p>
      )}
    </div>
  );
}
