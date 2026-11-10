// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, type Job, type JobCounts, type JobStatus } from "@/lib/api";
import { formatShortDateTime } from "@/lib/format";
import { HistoryList } from "./HistoryList";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  listJobs: vi.fn(),
  getJobCounts: vi.fn(),
}));
import { getJobCounts, listJobs } from "@/lib/api";

const listJobsMock = vi.mocked(listJobs);
const getJobCountsMock = vi.mocked(getJobCounts);

const job = (n: number, extra: Partial<Job> = {}): Job => ({
  id: `job-${n}`,
  url: `https://site${n}.test/`,
  status: "Completed",
  maxDepth: 2,
  maxPages: 200,
  failureReason: null,
  createdAt: new Date(Date.now() - n * 3_600_000).toISOString(),
  startedAt: new Date(Date.now() - n * 3_600_000).toISOString(),
  completedAt: new Date(Date.now() - n * 3_600_000 + 4_000).toISOString(),
  progress: { pagesDiscovered: 12, pagesProcessed: 12 },
  ...extra,
});
const page = (items: Job[], nextCursor: string | null = null) => ({ items, nextCursor });
const counts = (by: Partial<Record<JobStatus, number>> = {}): JobCounts => {
  const byStatus = { Pending: 0, Running: 0, Completed: 0, Failed: 0, Canceled: 0, ...by };
  return { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus };
};
const rows = () => within(screen.getByRole("list", { name: /previous crawl jobs/i })).getAllByRole("listitem");
const hosts = () => rows().map((r) => within(r).getByRole("link").textContent?.match(/site\d+\.test/)?.[0]);
const chips = () => within(screen.getByRole("group", { name: "Filter by status" }));
/** A promise the test resolves by hand, to control which answer arrives first. */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

beforeEach(() => {
  listJobsMock.mockReset();
  getJobCountsMock.mockReset();
  getJobCountsMock.mockResolvedValue(counts({ Completed: 5 }));
});
afterEach(cleanup);

describe("HistoryList: the list", () => {
  it("shows a skeleton while loading, then the jobs, asking the server for the first page of everything", async () => {
    listJobsMock.mockResolvedValue(page([job(1), job(2)]));
    render(<HistoryList />);
    expect(screen.getByRole("status", { name: "Loading history" })).toBeTruthy();
    expect(await screen.findByRole("list", { name: /previous crawl jobs/i })).toBeTruthy();
    expect(rows()).toHaveLength(2);
    expect(listJobsMock).toHaveBeenCalledWith(expect.objectContaining({ status: undefined }));
    expect(listJobsMock.mock.calls[0][0]?.cursor).toBeUndefined();
  });

  it("makes each row a link to its job, showing host, address, status, pages, duration and age", async () => {
    listJobsMock.mockResolvedValue(page([job(1, { progress: { pagesDiscovered: 74, pagesProcessed: 74 } })]));
    render(<HistoryList />);
    const link = within((await waitFor(() => rows()))[0]).getByRole("link");
    expect(link.getAttribute("href")).toBe("/jobs/job-1");
    for (const text of ["site1.test", "https://site1.test/", "Completed", "74 pages", "4.0 s", "1 h ago"]) expect(link.textContent).toContain(text);
  });

  describe("timestamps", () => {
    const sample = job(1);

    it("shows when each job was created and when it finished, as dates, with the age beneath", async () => {
      listJobsMock.mockResolvedValue(page([sample]));
      render(<HistoryList />);
      const row = (await waitFor(() => rows()))[0];
      const times = row.querySelectorAll("time");

      expect(times).toHaveLength(2);
      expect(times[0].textContent).toBe(formatShortDateTime(sample.createdAt));
      expect(times[0].getAttribute("datetime")).toBe(sample.createdAt);
      expect(times[1].textContent).toBe(formatShortDateTime(sample.completedAt));
      expect(times[1].getAttribute("datetime")).toBe(sample.completedAt);
      expect(row.textContent).toContain("1 h ago");
    });

    it("shows a dash instead of a finish time for a job that has not finished", async () => {
      listJobsMock.mockResolvedValue(page([job(1, { status: "Running", completedAt: null })]));
      getJobCountsMock.mockResolvedValue(counts({ Running: 1 }));
      render(<HistoryList />);
      const row = (await waitFor(() => rows()))[0];
      expect(row.querySelectorAll("time")).toHaveLength(1); // only the creation time
      expect(within(row).getByLabelText("not finished yet").textContent).toBe("–");
    });

    it("puts a header over each column, including Created and Finished", async () => {
      listJobsMock.mockResolvedValue(page([job(1)]));
      const { container } = render(<HistoryList />);
      await waitFor(() => rows());
      const header = container.querySelector("[aria-hidden='true'].sm\\:flex") as HTMLElement;
      for (const name of ["Site", "Status", "Pages", "Duration", "Created", "Finished"]) expect(header.textContent).toContain(name);
    });
  });

  it("says 1 page, not 1 pages", async () => {
    listJobsMock.mockResolvedValue(page([job(1, { progress: { pagesDiscovered: 1, pagesProcessed: 1 } })]));
    render(<HistoryList />);
    expect((await waitFor(() => rows()))[0].textContent).toContain("1 page");
    expect(rows()[0].textContent).not.toContain("1 pages");
  });

  it("shows a friendly empty state with a way to start a crawl when there is no history at all", async () => {
    listJobsMock.mockResolvedValue(page([]));
    getJobCountsMock.mockResolvedValue(counts());
    render(<HistoryList />);
    expect(await screen.findByText("No crawls yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: /start your first crawl/i }).getAttribute("href")).toBe("/");
  });

  it("shows the error with a retry that loads the list", async () => {
    listJobsMock.mockRejectedValueOnce(new ApiRequestError(0, "NETWORK_ERROR", "Could not reach the API")).mockResolvedValue(page([job(1)]));
    const user = userEvent.setup();
    render(<HistoryList />);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the API");
    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("list", { name: /previous crawl jobs/i })).toBeTruthy();
  });
});

describe("HistoryList: filtering on the server", () => {
  beforeEach(() => {
    getJobCountsMock.mockResolvedValue(counts({ Completed: 40, Failed: 3, Running: 1, Pending: 1 }));
  });

  it("shows the real totals from the whole history, not just what has been loaded", async () => {
    listJobsMock.mockResolvedValue(page([job(1), job(2)], "more")); // only 2 loaded
    render(<HistoryList />);
    await screen.findByRole("list", { name: /previous crawl jobs/i });
    await waitFor(() => expect(chips().getByRole("button", { name: /all 45/i })).toBeTruthy());
    expect(chips().getByRole("button", { name: /completed 40/i })).toBeTruthy();
    expect(chips().getByRole("button", { name: /failed 3/i })).toBeTruthy();
    expect(chips().getByRole("button", { name: /in progress 2/i })).toBeTruthy(); // Pending + Running
  });

  it("leaves out statuses nobody has, but keeps All", async () => {
    getJobCountsMock.mockResolvedValue(counts({ Completed: 4 }));
    listJobsMock.mockResolvedValue(page([job(1)]));
    render(<HistoryList />);
    await waitFor(() => expect(chips().getByRole("button", { name: /all 4/i })).toBeTruthy());
    expect(chips().queryByRole("button", { name: /failed/i })).toBeNull();
    expect(chips().queryByRole("button", { name: /canceled/i })).toBeNull();
    expect(chips().queryByRole("button", { name: /in progress/i })).toBeNull();
  });

  it("asks the server for that status, from the first page, when a chip is pressed", async () => {
    listJobsMock.mockImplementation(async ({ status } = {}) => (status ? page([job(7, { status: "Failed" })]) : page([job(1), job(2)])));
    const user = userEvent.setup();
    render(<HistoryList />);
    await screen.findByRole("list", { name: /previous crawl jobs/i });

    await user.click(await screen.findByRole("button", { name: /failed 3/i }));

    await waitFor(() => expect(hosts()).toEqual(["site7.test"]));
    expect(listJobsMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: ["Failed"] }));
    expect(listJobsMock.mock.lastCall?.[0]?.cursor).toBeUndefined();
  });

  it("sends Pending and Running together for 'in progress'", async () => {
    listJobsMock.mockResolvedValue(page([job(1)]));
    const user = userEvent.setup();
    render(<HistoryList />);
    await user.click(await screen.findByRole("button", { name: /in progress 2/i }));
    await waitFor(() => expect(listJobsMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: ["Pending", "Running"] })));
  });

  it("goes back to everything with All", async () => {
    listJobsMock.mockResolvedValue(page([job(1)]));
    const user = userEvent.setup();
    render(<HistoryList />);
    await user.click(await screen.findByRole("button", { name: /failed 3/i }));
    await user.click(screen.getByRole("button", { name: /all 45/i }));
    await waitFor(() => expect(listJobsMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: undefined })));
  });

  it("marks the selected chip", async () => {
    listJobsMock.mockResolvedValue(page([job(1)]));
    const user = userEvent.setup();
    render(<HistoryList />);
    await user.click(await screen.findByRole("button", { name: /failed 3/i }));
    expect(chips().getByRole("button", { name: /failed 3/i }).getAttribute("aria-pressed")).toBe("true");
    expect(chips().getByRole("button", { name: /all 45/i }).getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the chips on screen and shows a list skeleton while the new filter loads", async () => {
    const slow = deferred<ReturnType<typeof page>>();
    listJobsMock.mockResolvedValueOnce(page([job(1)])).mockReturnValueOnce(slow.promise);
    const user = userEvent.setup();
    render(<HistoryList />);
    await user.click(await screen.findByRole("button", { name: /failed 3/i }));

    expect(screen.getByRole("status", { name: "Loading crawls" })).toBeTruthy();
    expect(chips().getByRole("button", { name: /failed 3/i })).toBeTruthy(); // not replaced by a page-wide skeleton
    slow.resolve(page([job(7, { status: "Failed" })]));
    await waitFor(() => expect(hosts()).toEqual(["site7.test"]));
  });

  it("ignores a slow answer for a filter the user has already left", async () => {
    const first = deferred<ReturnType<typeof page>>();
    listJobsMock.mockResolvedValueOnce(page([job(1)])); // initial: all
    const user = userEvent.setup();
    render(<HistoryList />);
    await screen.findByRole("list", { name: /previous crawl jobs/i });

    listJobsMock.mockReturnValueOnce(first.promise); // "Failed": will answer late
    await user.click(screen.getByRole("button", { name: /failed 3/i }));
    listJobsMock.mockResolvedValueOnce(page([job(9)])); // "Completed": answers at once
    await user.click(screen.getByRole("button", { name: /completed 40/i }));
    await waitFor(() => expect(hosts()).toEqual(["site9.test"]));

    first.resolve(page([job(7, { status: "Failed" })])); // the stale one arrives last
    await new Promise((r) => setTimeout(r, 30));
    expect(hosts()).toEqual(["site9.test"]); // and does not overwrite what the user chose
  });

  it("explains an empty result for the chosen status", async () => {
    listJobsMock.mockResolvedValueOnce(page([job(1)])).mockResolvedValueOnce(page([]));
    const user = userEvent.setup();
    render(<HistoryList />);
    await user.click(await screen.findByRole("button", { name: /failed 3/i }));
    expect(await screen.findByText("No failed crawls")).toBeTruthy();
    expect(screen.getByText("None in your history.")).toBeTruthy();
    expect(chips().getByRole("button", { name: /failed 3/i })).toBeTruthy(); // the way back is still there
  });

  it("keeps a chip visible while it is selected, even if its count has dropped to zero", async () => {
    listJobsMock.mockResolvedValueOnce(page([job(1)])).mockResolvedValueOnce(page([job(2, { status: "Failed" })]));
    const user = userEvent.setup();
    render(<HistoryList />);
    await user.click(await screen.findByRole("button", { name: /failed 3/i }));
    await screen.findByRole("list", { name: /previous crawl jobs/i });

    getJobCountsMock.mockResolvedValue(counts({ Completed: 40 })); // the failed ones were all cleaned up
    listJobsMock.mockResolvedValueOnce(page([]));
    await user.click(screen.getByRole("button", { name: /refresh/i }));
    expect(await screen.findByText("No failed crawls")).toBeTruthy();
    expect(chips().getByRole("button", { name: /failed 0/i }).getAttribute("aria-pressed")).toBe("true");
  });

  it("still shows the list, without numbers on the chips, when the counts cannot be loaded", async () => {
    getJobCountsMock.mockRejectedValue(new ApiRequestError(500, "INTERNAL_ERROR", "boom"));
    listJobsMock.mockResolvedValue(page([job(1)]));
    render(<HistoryList />);
    expect(await screen.findByRole("list", { name: /previous crawl jobs/i })).toBeTruthy();
    expect(chips().getByRole("button", { name: "All" })).toBeTruthy();
    expect(chips().getByRole("button", { name: "Failed" })).toBeTruthy(); // shown, since nothing says they are empty
  });

  it("shows an error for a failed filter change, with the chips and a retry", async () => {
    listJobsMock.mockResolvedValueOnce(page([job(1)])).mockRejectedValueOnce(new ApiRequestError(0, "NETWORK_ERROR", "Could not reach the API")).mockResolvedValue(page([job(7)]));
    const user = userEvent.setup();
    render(<HistoryList />);
    await user.click(await screen.findByRole("button", { name: /failed 3/i }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the API");
    expect(chips().getByRole("button", { name: /failed 3/i })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(hosts()).toEqual(["site7.test"]));
    expect(listJobsMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: ["Failed"] })); // the retry kept the filter
  });

  it("refreshes both the list and the counts, keeping the chosen filter", async () => {
    listJobsMock.mockResolvedValue(page([job(1)]));
    const user = userEvent.setup();
    render(<HistoryList />);
    await user.click(await screen.findByRole("button", { name: /failed 3/i }));
    const listCalls = listJobsMock.mock.calls.length;
    const countCalls = getJobCountsMock.mock.calls.length;

    await user.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(listJobsMock.mock.calls.length).toBe(listCalls + 1));
    expect(getJobCountsMock.mock.calls.length).toBe(countCalls + 1);
    expect(listJobsMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: ["Failed"] }));
  });
});

describe("HistoryList: load more", () => {
  it("appends the next page using the cursor, then says it is the end", async () => {
    listJobsMock.mockResolvedValueOnce(page([job(1), job(2)], "cursor-1")).mockResolvedValueOnce(page([job(3)], null));
    const user = userEvent.setup();
    render(<HistoryList />);
    await screen.findByRole("list", { name: /previous crawl jobs/i });
    expect(screen.queryByText(/everything/)).toBeNull();

    await user.click(screen.getByRole("button", { name: /load more/i }));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(listJobsMock).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "cursor-1" }));
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
    expect(screen.getByText(/That.s everything: 3 crawls/)).toBeTruthy();
  });

  it("passes the chosen status again with the cursor, so every page is filtered", async () => {
    listJobsMock
      .mockResolvedValueOnce(page([job(1)]))
      .mockResolvedValueOnce(page([job(2, { status: "Failed" })], "cursor-f"))
      .mockResolvedValueOnce(page([job(3, { status: "Failed" })], null));
    getJobCountsMock.mockResolvedValue(counts({ Completed: 1, Failed: 2 }));
    const user = userEvent.setup();
    render(<HistoryList />);
    await user.click(await screen.findByRole("button", { name: /failed 2/i }));
    await user.click(await screen.findByRole("button", { name: /load more/i }));

    await waitFor(() => expect(hosts()).toEqual(["site2.test", "site3.test"]));
    expect(listJobsMock).toHaveBeenLastCalledWith({ cursor: "cursor-f", status: ["Failed"], signal: undefined });
  });

  it("does not add a late page to a list for a different filter", async () => {
    const late = deferred<ReturnType<typeof page>>();
    getJobCountsMock.mockResolvedValue(counts({ Completed: 3, Failed: 1 }));
    listJobsMock
      .mockResolvedValueOnce(page([job(1)], "cursor-all")) // all, with more
      .mockReturnValueOnce(late.promise); // load more for "all": answers late
    const user = userEvent.setup();
    render(<HistoryList />);
    await user.click(await screen.findByRole("button", { name: /load more/i }));

    listJobsMock.mockResolvedValueOnce(page([job(7, { status: "Failed" })], null)); // the user switches to Failed
    await user.click(screen.getByRole("button", { name: /failed 1/i }));
    await waitFor(() => expect(hosts()).toEqual(["site7.test"]));

    late.resolve(page([job(2)], null)); // the page for "all" arrives
    await new Promise((r) => setTimeout(r, 30));
    expect(hosts()).toEqual(["site7.test"]); // it did not leak into the Failed list
  });

  it("keeps the rows it has and offers a retry when loading more fails", async () => {
    listJobsMock
      .mockResolvedValueOnce(page([job(1)], "cursor-1"))
      .mockRejectedValueOnce(new ApiRequestError(500, "INTERNAL_ERROR", "Internal server error"))
      .mockResolvedValueOnce(page([job(2)], null));
    const user = userEvent.setup();
    render(<HistoryList />);
    await screen.findByRole("list", { name: /previous crawl jobs/i });

    await user.click(screen.getByRole("button", { name: /load more/i }));
    expect((await screen.findByRole("alert")).textContent).toContain("Internal server error");
    expect(rows()).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(rows()).toHaveLength(2));
  });
});
