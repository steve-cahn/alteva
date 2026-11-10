"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, getJob, type Job } from "./api";
import { isTerminal } from "./format";

export const POLL_INTERVAL_MS = 1500;

export type JobState =
  | { kind: "loading" }
  | { kind: "error"; error: Error }
  /** `pollError` is set when a refresh failed but the last known job is still shown. */
  | { kind: "ready"; job: Job; pollError: string | null };

/**
 * Loads a job and polls it every 1.5s until it reaches a terminal status.
 *  - first load fails: error state, with `retry`
 *  - a later poll fails: keep showing the job with a warning, and keep polling
 *  - job not found (404 / bad id): stop, nothing to poll
 */
export function useJob(id: string) {
  const [state, setState] = useState<JobState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loaded = false;

    async function poll() {
      try {
        const job = await getJob(id, controller.signal);
        if (controller.signal.aborted) return; // a different job (or no job) is on screen now
        loaded = true;
        setState({ kind: "ready", job, pollError: null });
        if (isTerminal(job.status)) return;
      } catch (err) {
        if (controller.signal.aborted) return;
        const gone = err instanceof ApiRequestError && err.isNotFound;
        if (!loaded || gone) {
          setState({ kind: "error", error: err as Error });
          return;
        }
        const message = err instanceof Error ? err.message : "Request failed";
        setState((prev) => (prev.kind === "ready" ? { ...prev, pollError: message } : prev));
      }
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, attempt]);

  const retry = useCallback(() => {
    setState({ kind: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  /** Show a job returned by another call (e.g. cancel) without waiting for the next poll. */
  const update = useCallback((job: Job) => setState({ kind: "ready", job, pollError: null }), []);

  return { state, retry, update };
}
