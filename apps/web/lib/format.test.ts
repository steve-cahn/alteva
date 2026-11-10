import { describe, expect, it } from "vitest";
import { formatDateTime, formatDuration, formatShortDateTime, formatRatio, hostOf, isCancelable, isTerminal, jobDurationMs, pathOf, progressPercent, timeAgo } from "./format";

describe("formatRatio", () => {
  it("renders a ratio as a whole percentage", () => {
    expect(formatRatio(0)).toBe("0%");
    expect(formatRatio(0.8)).toBe("80%");
    expect(formatRatio(1)).toBe("100%");
    expect(formatRatio(1 / 3)).toBe("33%");
    expect(formatRatio(2 / 3)).toBe("67%");
  });

  it("renders a dash when the page was not crawled as HTML", () => {
    expect(formatRatio(null)).toBe("–");
  });
});

describe("progressPercent", () => {
  it("is processed over discovered, rounded", () => {
    expect(progressPercent(3, 6)).toBe(50);
    expect(progressPercent(1, 3)).toBe(33);
    expect(progressPercent(6, 6)).toBe(100);
  });

  it("is 0 when nothing is discovered yet, and never above 100", () => {
    expect(progressPercent(0, 0)).toBe(0);
    expect(progressPercent(5, 0)).toBe(0);
    expect(progressPercent(7, 6)).toBe(100);
  });
});

describe("status helpers", () => {
  it.each(["Completed", "Failed", "Canceled"])("%s is terminal and not cancelable", (status) => {
    expect(isTerminal(status)).toBe(true);
    expect(isCancelable(status)).toBe(false);
  });

  it.each(["Pending", "Running"])("%s is neither terminal nor beyond cancel", (status) => {
    expect(isTerminal(status)).toBe(false);
    expect(isCancelable(status)).toBe(true);
  });

  it("treats an unknown status as non-terminal so polling keeps going", () => {
    expect(isTerminal("Whatever")).toBe(false);
  });
});

describe("formatDateTime", () => {
  it("renders a dash for an event that has not happened", () => {
    expect(formatDateTime(null)).toBe("–");
  });

  it("renders a real timestamp with its date and time", () => {
    const text = formatDateTime("2026-03-04T05:06:07.000Z");
    expect(text).toMatch(/2026/);
    expect(text).not.toBe("–");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0 ms"],
    [850, "850 ms"],
    [1000, "1.0 s"],
    [4200, "4.2 s"],
    [12_400, "12 s"],
    [59_400, "59 s"],
    [72_000, "1 m 12 s"],
    [3_600_000, "1 h 0 m"],
    [7_500_000, "2 h 5 m"],
  ])("%d ms -> %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it("never shows a negative duration", () => {
    expect(formatDuration(-5)).toBe("0 ms");
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-06-15T12:00:00Z");
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  it.each([
    [0, "just now"],
    [30, "just now"],
    [90, "2 min ago"],
    [60 * 59, "59 min ago"],
    [3600 * 3, "3 h ago"],
    [86_400 * 2, "2 d ago"],
  ])("%d s ago -> %s", (seconds, expected) => {
    expect(timeAgo(ago(seconds), now)).toBe(expected);
  });

  it("uses the date once it is more than a month old", () => {
    expect(timeAgo(ago(86_400 * 90), now)).toMatch(/2026/);
  });

  it("treats a timestamp slightly in the future (clock skew) as now", () => {
    expect(timeAgo(ago(-20), now)).toBe("just now");
  });
});

describe("jobDurationMs", () => {
  const now = Date.parse("2026-01-01T00:01:00Z");

  it("is null until the job has started", () => {
    expect(jobDurationMs({ startedAt: null, completedAt: null }, now)).toBeNull();
  });

  it("runs to the completion time when there is one", () => {
    expect(jobDurationMs({ startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:04Z" }, now)).toBe(4000);
  });

  it("runs to now while the job is still going", () => {
    expect(jobDurationMs({ startedAt: "2026-01-01T00:00:30Z", completedAt: null }, now)).toBe(30_000);
  });
});

describe("hostOf / pathOf", () => {
  it("splits a URL into its host and its path", () => {
    expect(hostOf("https://www.example.com:8080/a/b?c=1")).toBe("www.example.com:8080");
    expect(pathOf("https://example.com/a/b?c=1")).toBe("/a/b?c=1");
    expect(pathOf("https://example.com")).toBe("/");
  });

  it("returns the input when it is not a URL", () => {
    expect(hostOf("not a url")).toBe("not a url");
    expect(pathOf("not a url")).toBe("not a url");
  });
});

describe("formatShortDateTime", () => {
  const now = new Date(2026, 5, 15, 12, 0).getTime(); // local time, so the test does not depend on the time zone
  const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).toISOString();

  it("is a dash for an event that has not happened", () => {
    expect(formatShortDateTime(null, now)).toBe("–");
  });

  it("leaves out the year for this year", () => {
    const text = formatShortDateTime(local(2026, 10, 3, 14, 34), now);
    expect(text).toMatch(/Nov/);
    expect(text).toMatch(/3/);
    expect(text).not.toMatch(/2026/);
  });

  it("includes the year for another year", () => {
    expect(formatShortDateTime(local(2025, 10, 3, 14, 34), now)).toMatch(/2025/);
  });

  it("shows the minutes", () => {
    expect(formatShortDateTime(local(2026, 10, 3, 14, 5), now)).toMatch(/05/);
  });
});
