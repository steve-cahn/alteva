// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@/lib/api";
import { JobDetails, JobView } from "./JobView";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getJob: vi.fn(),
  getJobTree: vi.fn(async () => ({ jobId: "j1", status: "Completed", tree: null })),
}));
import { getJob } from "@/lib/api";

const getJobMock = vi.mocked(getJob);

const job = (extra: Partial<Job> = {}): Job => ({
  id: "j1",
  url: "https://site.test/",
  status: "Running",
  maxDepth: 2,
  maxPages: 200,
  failureReason: null,
  createdAt: "2026-01-01T00:00:00Z",
  startedAt: null,
  completedAt: null,
  progress: { pagesDiscovered: 7, pagesProcessed: 5 },
  ...extra,
});

/** A promise React's `use` treats as already resolved, so the test does not depend on suspense retries. */
function resolved<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: "fulfilled" as const, value });
}

async function renderJob() {
  render(
    <Suspense fallback="loading">
      <JobView params={resolved({ id: "j1" })} />
    </Suspense>,
  );
  await screen.findByRole("heading", { name: "site.test" });
}

beforeEach(() => getJobMock.mockReset());
afterEach(cleanup);

const statusItems = () =>
  within(screen.getByRole("list", { name: "Pages by status" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);

describe("JobView page counts", () => {
  it("shows the pages by status, leaving out the empty ones", async () => {
    getJobMock.mockResolvedValue(job({ pageCounts: { queued: 2, done: 3, skipped: 0, failed: 1 } }));
    await renderJob();
    expect(statusItems()).toEqual(["3 done", "2 queued", "1 failed"]);
  });

  it("shows nothing when the job has no page counts yet", async () => {
    getJobMock.mockResolvedValue(job());
    await renderJob();
    expect(screen.queryByRole("list", { name: "Pages by status" })).toBeNull();
  });

  it("shows nothing when there are no pages at all", async () => {
    getJobMock.mockResolvedValue(job({ pageCounts: { queued: 0, done: 0, skipped: 0, failed: 0 } }));
    await renderJob();
    expect(screen.queryByRole("list", { name: "Pages by status" })).toBeNull();
  });
});

describe("JobView", () => {
  it("names the job by its host, links to the full address, and shows the id", async () => {
    getJobMock.mockResolvedValue(job());
    await renderJob();
    expect(screen.getByRole("link", { name: /https:\/\/site\.test\// }).getAttribute("href")).toBe("https://site.test/");
    expect(screen.getByText("j1")).toBeTruthy();
  });

  it("shows the key numbers as tiles", async () => {
    getJobMock.mockResolvedValue(job({ progress: { pagesDiscovered: 7, pagesProcessed: 5 }, maxDepth: 3 }));
    await renderJob();
    const tile = (label: string) => screen.getByText(label).closest("div")?.textContent ?? "";
    expect(tile("Pages found")).toContain("7");
    expect(tile("Pages processed")).toContain("5of 7");
    expect(tile("Max depth")).toContain("3");
  });

  it("offers Cancel on an active job and New crawl on a finished one, never both", async () => {
    getJobMock.mockResolvedValue(job({ status: "Running" }));
    await renderJob();
    expect(screen.getByRole("button", { name: /cancel crawl/i })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "New crawl" })).toBeNull();
    cleanup();

    getJobMock.mockResolvedValue(job({ status: "Canceled", completedAt: "2026-01-01T00:00:05Z" }));
    await renderJob();
    expect(screen.queryByRole("button", { name: /cancel crawl/i })).toBeNull();
    expect(screen.getByRole("link", { name: "New crawl" })).toBeTruthy();
  });

  it("explains a failure with its reason", async () => {
    getJobMock.mockResolvedValue(job({ status: "Failed", failureReason: "Could not fetch the start page: HTTP 404" }));
    await renderJob();
    expect(screen.getByRole("alert").textContent).toContain("Could not fetch the start page: HTTP 404");
  });

  it("is a progress bar while the job runs, with the stacked status breakdown as the bar", async () => {
    getJobMock.mockResolvedValue(job({ status: "Running", pageCounts: { queued: 2, done: 5, skipped: 0, failed: 0 } }));
    await renderJob();
    const bar = screen.getByRole("progressbar", { name: "Pages processed" });
    expect(bar.getAttribute("aria-valuenow")).toBe("5");
    expect(bar.getAttribute("aria-valuemax")).toBe("7");
  });

  it("is not a progress bar once the job is finished", async () => {
    getJobMock.mockResolvedValue(job({ status: "Completed", pageCounts: { queued: 0, done: 7, skipped: 0, failed: 0 } }));
    await renderJob();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(statusItems()).toEqual(["7 done"]);
  });

  it("falls back to a plain progress bar when there is no status breakdown", async () => {
    getJobMock.mockResolvedValue(job({ status: "Running" }));
    await renderJob();
    expect(screen.getByRole("progressbar", { name: "Pages processed" }).getAttribute("aria-valuenow")).toBe("5");
  });

  it("says when the API cannot be reached while polling, and keeps showing the job", () => {
    render(<JobDetails job={job({ status: "Running" })} pollError="Could not reach the API" onUpdate={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("Lost contact with the API, still trying: Could not reach the API");
    expect(screen.getByRole("heading", { name: "site.test" })).toBeTruthy();
  });

  it("shows no warning while polling is healthy", () => {
    render(<JobDetails job={job({ status: "Running" })} pollError={null} onUpdate={vi.fn()} />);
    expect(screen.queryByText(/Lost contact/)).toBeNull();
  });

  it("copies the job id", async () => {
    getJobMock.mockResolvedValue(job());
    const user = userEvent.setup(); // installs its own clipboard, so replace that afterwards
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await renderJob();
    await user.click(screen.getByRole("button", { name: "Copy job id" }));
    expect(writeText).toHaveBeenCalledWith("j1");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });
});
