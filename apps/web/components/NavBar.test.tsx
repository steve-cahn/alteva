// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NavBarView } from "./NavBar";

afterEach(cleanup);
const current = () => screen.queryAllByRole("link").filter((l) => l.getAttribute("aria-current") === "page").map((l) => l.textContent);

describe("NavBarView", () => {
  it.each([
    ["/", ["New crawl"]],
    ["/history", ["History"]],
    ["/history/anything", ["History"]],
    ["/jobs/abc", []],
    [null, []],
  ])("on %s the highlighted link is %j", (path, expected) => {
    render(<NavBarView active={path} />);
    expect(current()).toEqual(expected);
  });

  it("links to the home page, new crawl and history", () => {
    render(<NavBarView active={null} />);
    const hrefs = screen.getAllByRole("link").map((l) => l.getAttribute("href"));
    expect(hrefs).toEqual(["/", "/", "/history"]);
  });
});
