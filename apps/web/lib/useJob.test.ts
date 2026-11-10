// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, type Job } from "./api";
import { POLL_INTERVAL_MS, useJob } from "./useJob";

vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), getJob: vi.fn() }));
import { getJob } from "./api";

const getJobMock = vi.mocked(getJob);

const job = (status: Job["status"], processed = 0): Job => ({
  id: "j1",
  url: "https://site.test/",
  status,
  maxDepth: 2,
  maxPages: 200,
  failureReason: null,
  createdAt: "2026-01-01T00:00:00Z",
  startedAt: null,
  completedAt: null,
  progress: { pagesDiscovered: 5, pagesProcessed: processed },
});

/** Let the pending promise callbacks (state updates) run. */
const flush = () => act(async () => {});
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers();
  getJobMock.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("useJob", () => {
  it("starts loading, then shows the job", async () => {
    getJobMock.mockResolvedValue(job("Running", 1));
    const { result } = renderHook(() => useJob("j1"));
    expect(result.current.state.kind).toBe("loading");

    await flush();
    expect(result.current.state).toMatchObject({ kind: "ready", job: { status: "Running" }, pollError: null });
  });

  it("polls every 1.5s while the job is not finished", async () => {
    getJobMock.mockResolvedValue(job("Running"));
    renderHook(() => useJob("j1"));
    await flush();
    expect(getJobMock).toHaveBeenCalledTimes(1);

    await advance(POLL_INTERVAL_MS - 1);
    expect(getJobMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(getJobMock).toHaveBeenCalledTimes(2);
    await advance(POLL_INTERVAL_MS);
    expect(getJobMock).toHaveBeenCalledTimes(3);
  });

  it("shows progress as it changes between polls", async () => {
    getJobMock.mockResolvedValueOnce(job("Running", 1)).mockResolvedValue(job("Running", 4));
    const { result } = renderHook(() => useJob("j1"));
    await flush();
    await advance(POLL_INTERVAL_MS);
    expect(result.current.state).toMatchObject({ job: { progress: { pagesProcessed: 4 } } });
  });

  it.each(["Completed", "Failed", "Canceled"] as const)("stops polling once the job is %s", async (status) => {
    getJobMock.mockResolvedValueOnce(job("Running")).mockResolvedValue(job(status));
    const { result } = renderHook(() => useJob("j1"));
    await flush();
    await advance(POLL_INTERVAL_MS);
    expect(result.current.state).toMatchObject({ job: { status } });

    const calls = getJobMock.mock.calls.length;
    await advance(POLL_INTERVAL_MS * 5);
    expect(getJobMock).toHaveBeenCalledTimes(calls);
  });

  it("does not poll at all for a job that is already finished", async () => {
    getJobMock.mockResolvedValue(job("Completed"));
    renderHook(() => useJob("j1"));
    await flush();
    await advance(POLL_INTERVAL_MS * 3);
    expect(getJobMock).toHaveBeenCalledTimes(1);
  });

  it("errors, without polling, when the first load fails, and recovers on retry", async () => {
    getJobMock.mockRejectedValueOnce(new ApiRequestError(0, "NETWORK_ERROR", "unreachable")).mockResolvedValue(job("Running"));
    const { result } = renderHook(() => useJob("j1"));
    await flush();
    expect(result.current.state).toMatchObject({ kind: "error" });
    await advance(POLL_INTERVAL_MS * 3);
    expect(getJobMock).toHaveBeenCalledTimes(1);

    act(() => result.current.retry());
    expect(result.current.state.kind).toBe("loading");
    await flush();
    expect(result.current.state).toMatchObject({ kind: "ready", job: { status: "Running" } });
  });

  it("keeps the job on screen and keeps polling when a later poll fails", async () => {
    getJobMock
      .mockResolvedValueOnce(job("Running", 1))
      .mockRejectedValueOnce(new ApiRequestError(0, "NETWORK_ERROR", "unreachable"))
      .mockResolvedValue(job("Running", 3));
    const { result } = renderHook(() => useJob("j1"));
    await flush();

    await advance(POLL_INTERVAL_MS);
    expect(result.current.state).toMatchObject({ kind: "ready", job: { progress: { pagesProcessed: 1 } }, pollError: "unreachable" });

    await advance(POLL_INTERVAL_MS);
    expect(result.current.state).toMatchObject({ kind: "ready", job: { progress: { pagesProcessed: 3 } }, pollError: null });
  });

  it("stops polling when the job turns out not to exist", async () => {
    getJobMock.mockResolvedValueOnce(job("Running")).mockRejectedValue(new ApiRequestError(404, "NOT_FOUND", "gone"));
    const { result } = renderHook(() => useJob("j1"));
    await flush();
    await advance(POLL_INTERVAL_MS);
    expect(result.current.state).toMatchObject({ kind: "error" });

    const calls = getJobMock.mock.calls.length;
    await advance(POLL_INTERVAL_MS * 3);
    expect(getJobMock).toHaveBeenCalledTimes(calls);
  });

  it("stops polling when unmounted", async () => {
    getJobMock.mockResolvedValue(job("Running"));
    const { unmount } = renderHook(() => useJob("j1"));
    await flush();
    unmount();
    await advance(POLL_INTERVAL_MS * 3);
    expect(getJobMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a job from another call (cancel) without waiting for the next poll", async () => {
    getJobMock.mockResolvedValue(job("Running"));
    const { result } = renderHook(() => useJob("j1"));
    await flush();
    act(() => result.current.update(job("Canceled")));
    expect(result.current.state).toMatchObject({ job: { status: "Canceled" } });
  });
});
