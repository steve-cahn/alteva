// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DepthPicker } from "./DepthPicker";

afterEach(cleanup);

describe("DepthPicker", () => {
  it("offers depths 0 to 5 as radio buttons and checks the current one", () => {
    render(<DepthPicker value={3} onChange={vi.fn()} />);
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(radios.filter((r) => r.checked).map((r) => r.value)).toEqual(["3"]);
  });

  it("reports the chosen depth as a number", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DepthPicker value={2} onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: "4" }));
    expect(onChange).toHaveBeenCalledWith(4);
  });

  it("can choose 0, and describes it as the start page only", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<DepthPicker value={2} onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: "0" }));
    expect(onChange).toHaveBeenCalledWith(0); // a real number 0, not a missing value

    rerender(<DepthPicker value={0} onChange={onChange} />);
    expect(screen.getByText(/only the page you enter/i)).toBeTruthy();
  });

  it("works from the keyboard", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DepthPicker value={2} onChange={onChange} />);
    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it("describes the current depth, and marks 2 as the default", () => {
    const { rerender } = render(<DepthPicker value={2} onChange={vi.fn()} />);
    expect(screen.getByText(/a good default/i)).toBeTruthy();
    expect(screen.getByText("default")).toBeTruthy();

    rerender(<DepthPicker value={5} onChange={vi.fn()} />);
    expect(screen.getByText(/five hops/i)).toBeTruthy();
    expect(screen.queryByText("default")).toBeNull();
  });

  it("shows an api error in place of the description", () => {
    render(<DepthPicker value={2} onChange={vi.fn()} error="must be a whole number from 0 to 200" />);
    expect(screen.getByText("Max depth must be a whole number from 0 to 200")).toBeTruthy();
    expect(screen.queryByText(/a good default/i)).toBeNull();
  });
});
