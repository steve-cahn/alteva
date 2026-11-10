import type { JobStatus } from "./api";

const TERMINAL: ReadonlySet<string> = new Set<JobStatus>(["Completed", "Failed", "Canceled"]);

/** A job in a terminal status never changes again, so polling can stop. */
export const isTerminal = (status: string): boolean => TERMINAL.has(status);

export const isCancelable = (status: string): boolean => status === "Pending" || status === "Running";

/** 0.8 -> "80%". Null (page not crawled as HTML) -> "–". */
export function formatRatio(ratio: number | null): string {
  return ratio === null ? "–" : `${Math.round(ratio * 100)}%`;
}

/** Share of discovered pages that are processed, as a whole percent. 0 when nothing is discovered yet. */
export function progressPercent(processed: number, discovered: number): number {
  if (discovered <= 0) return 0;
  return Math.min(100, Math.round((processed / discovered) * 100));
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

/** Local date and time, or "–" when the event has not happened yet. */
export function formatDateTime(iso: string | null): string {
  return iso ? dateTime.format(new Date(iso)) : "–";
}

/** 850 ms, 4.2 s, 1 m 12 s, 2 h 5 m. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ${Math.round(seconds - minutes * 60)} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes - hours * 60} m`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago"; older than a month falls back to the date. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** How long a job ran: from start to finish, or to `now` while it is still going. Null before it starts. */
export function jobDurationMs(job: { startedAt: string | null; completedAt: string | null }, now: number = Date.now()): number | null {
  if (!job.startedAt) return null;
  const end = job.completedAt ? new Date(job.completedAt).getTime() : now;
  return Math.max(0, end - new Date(job.startedAt).getTime());
}

/** `https://www.example.com/a?b=1` -> `www.example.com`. Falls back to the input for anything unparseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** `https://example.com/a/b?c=1` -> `/a/b?c=1`; the root is `/`. */
export function pathOf(url: string): string {
  try {
    const { pathname, search } = new URL(url);
    return `${pathname}${search}` || "/";
  } catch {
    return url;
  }
}

/**
 * A compact date and time for a list: "Nov 10, 2:34 PM", with the year only when it is not this one
 * ("Nov 10, 2025, 2:34 PM"). Dash when the event has not happened.
 */
export function formatShortDateTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "–";
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}
