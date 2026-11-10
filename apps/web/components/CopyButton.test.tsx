// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "./CopyButton";

afterEach(cleanup);

function setup(writeText: (text: string) => Promise<void>) {
  const user = userEvent.setup(); // installs its own clipboard, so replace that afterwards
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return user;
}

describe("CopyButton", () => {
  it("copies the value and confirms it", async () => {
    const writeText = vi.fn(async () => {});
    const user = setup(writeText);
    render(<CopyButton value="abc-123" label="Copy job id" />);
    await user.click(screen.getByRole("button", { name: "Copy job id" }));
    expect(writeText).toHaveBeenCalledWith("abc-123");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("goes back to its label after a moment", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = setup(async () => {});
      render(<CopyButton value="x" label="Copy it" />);
      await user.click(screen.getByRole("button", { name: "Copy it" }));
      expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
      await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
      expect(screen.getByRole("button", { name: "Copy it" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not claim success when the browser refuses the copy", async () => {
    const user = setup(async () => {
      throw new Error("denied");
    });
    render(<CopyButton value="x" label="Copy it" />);
    await user.click(screen.getByRole("button", { name: "Copy it" }));
    expect(screen.getByRole("button", { name: "Copy it" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });
});
