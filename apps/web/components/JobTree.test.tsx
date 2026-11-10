// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, type PageTreeNode } from "@/lib/api";
import { JobTree } from "./JobTree";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getJobTree: vi.fn(),
  getPageLinks: vi.fn(),
}));
import { getJobTree, getPageLinks } from "@/lib/api";

const getJobTreeMock = vi.mocked(getJobTree);
const getPageLinksMock = vi.mocked(getPageLinks);

const node = (url: string, extra: Partial<PageTreeNode> = {}): PageTreeNode => ({
  id: url,
  url,
  depth: 0,
  status: "done",
  domainLinkRatio: 1,
  outgoingCount: 3,
  children: [],
  ...extra,
});
const reply = (tree: PageTreeNode | null) => getJobTreeMock.mockResolvedValue({ jobId: "j", status: "Completed", tree });

beforeEach(() => {
  getJobTreeMock.mockReset();
  getPageLinksMock.mockReset();
});
afterEach(cleanup);

describe("JobTree", () => {
  it("shows a loading state, then each URL with its ratio as a percentage", async () => {
    reply(node("https://s.test/", { domainLinkRatio: 0.8, children: [node("https://s.test/a", { depth: 1, domainLinkRatio: 1 / 3 })] }));
    render(<JobTree jobId="j" />);
    expect(screen.getByRole("status", { name: "Loading pages" })).toBeTruthy();

    expect(await screen.findByText("https://s.test/")).toBeTruthy(); // the start page shows its full address
    expect(screen.getByText("80%")).toBeTruthy();
    expect(screen.getByText("/a")).toBeTruthy(); // its children show just their path
    expect(screen.getByText("33%")).toBeTruthy();
  });

  it("says 'no links found' instead of 0% for a page that has no links at all", async () => {
    reply(node("https://spa.test/", { domainLinkRatio: 0, outgoingCount: 0 }));
    render(<JobTree jobId="j" />);

    expect(await screen.findByText("no links found")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("still shows a real 0% when a page has links and none stay on the site", async () => {
    reply(node("https://s.test/", { domainLinkRatio: 0, outgoingCount: 4 }));
    render(<JobTree jobId="j" />);
    const tree = within(await screen.findByRole("list", { name: "Discovered pages" }));
    expect(tree.getByText("0%")).toBeTruthy();
    expect(tree.queryByText("no links found")).toBeNull();
  });

  it("shows the status, not a ratio, for pages that were not crawled as HTML", async () => {
    reply(
      node("https://s.test/", {
        children: [
          node("https://s.test/doc.pdf", { depth: 1, status: "skipped", domainLinkRatio: null, outgoingCount: null }),
          node("https://s.test/gone", { depth: 1, status: "failed", domainLinkRatio: null, outgoingCount: null }),
        ],
      }),
    );
    render(<JobTree jobId="j" />);
    expect(await screen.findByText("skipped")).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
  });

  it("shows an empty state when the job recorded no pages", async () => {
    reply(null);
    render(<JobTree jobId="j" />);
    expect(await screen.findByText(/no pages were recorded/i)).toBeTruthy();
  });

  it("shows the api error with a retry button when the tree cannot be loaded", async () => {
    getJobTreeMock.mockRejectedValueOnce(new ApiRequestError(0, "NETWORK_ERROR", "Could not reach the API"));
    render(<JobTree jobId="j" />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not reach the API");
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  describe("a page's outgoing links", () => {
    const withChild = () =>
      reply(node("https://s.test/", { outgoingCount: 3, children: [node("https://s.test/a", { depth: 1, outgoingCount: 2, children: [] })] }));
    const linksOf = (...urls: Array<[string, boolean]>) => ({
      pageId: "https://s.test/",
      url: "https://s.test/",
      total: urls.length,
      truncated: false,
      links: urls.map(([url, isInternal]) => ({ url, isInternal })),
    });

    it("offers a button with the link count on a crawled page that has links", async () => {
      withChild();
      render(<JobTree jobId="j" />);
      expect(await screen.findByRole("button", { name: "3 links" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "2 links" })).toBeTruthy();
    });

    it("offers no button for a page with no links, or one that was not crawled", async () => {
      reply(
        node("https://s.test/", {
          outgoingCount: 0,
          children: [node("https://s.test/doc.pdf", { depth: 1, status: "skipped", outgoingCount: null, domainLinkRatio: null })],
        }),
      );
      render(<JobTree jobId="j" />);
      const tree = within(await screen.findByRole("list", { name: "Discovered pages" }));
      await tree.findByText("no links found");
      expect(tree.queryByRole("button")).toBeNull(); // no "N links" button on either row
    });

    it("loads nothing until the button is pressed, then shows the links marked internal or external", async () => {
      reply(node("https://s.test/", { outgoingCount: 2 }));
      getPageLinksMock.mockResolvedValue(linksOf(["https://s.test/x", true], ["https://other.test/y", false]));
      const user = userEvent.setup();
      render(<JobTree jobId="j" />);
      const button = await screen.findByRole("button", { name: "2 links" });
      expect(getPageLinksMock).not.toHaveBeenCalled();
      expect(button.getAttribute("aria-expanded")).toBe("false");

      await user.click(button);

      expect(await screen.findByText("https://other.test/y")).toBeTruthy();
      expect(getPageLinksMock).toHaveBeenCalledWith("j", "https://s.test/", expect.anything());
      expect(screen.getByText("https://s.test/x")).toBeTruthy();
      expect(screen.getByText("internal", { selector: "li span" })).toBeTruthy();
      expect(screen.getByText("external", { selector: "li span" })).toBeTruthy();
      expect(screen.getByText(/1 internal, 1 external/)).toBeTruthy();
      expect(button.getAttribute("aria-expanded")).toBe("true");
    });

    it("hides the links again on a second press", async () => {
      reply(node("https://s.test/", { outgoingCount: 1 }));
      getPageLinksMock.mockResolvedValue(linksOf(["https://s.test/x", true]));
      const user = userEvent.setup();
      render(<JobTree jobId="j" />);
      const button = await screen.findByRole("button", { name: "1 link" });
      await user.click(button);
      await screen.findByText("https://s.test/x");
      await user.click(button);
      expect(screen.queryByText("internal", { selector: "li span" })).toBeNull();
    });

    // Note: jsdom does not model a <summary> toggling its <details> on click, so this checks the
    // behaviour a user sees (the node stays open) but would pass without the click guard in
    // NodeRow too. Browsers already leave a <details> alone for clicks on a button inside <summary>.
    it("does not fold the node when its links button is pressed", async () => {
      withChild();
      getPageLinksMock.mockResolvedValue(linksOf(["https://s.test/x", true]));
      const user = userEvent.setup();
      const { container } = render(<JobTree jobId="j" />);
      const button = await screen.findByRole("button", { name: "3 links" });
      const details = container.querySelector("details") as HTMLDetailsElement;
      expect(details.open).toBe(true);

      await user.click(button);

      expect(details.open).toBe(true);
      await screen.findByText("https://s.test/x");
    });

    it("shows the error, with a retry that loads the links", async () => {
      reply(node("https://s.test/", { outgoingCount: 1 }));
      getPageLinksMock
        .mockRejectedValueOnce(new ApiRequestError(0, "NETWORK_ERROR", "Could not reach the API"))
        .mockResolvedValue(linksOf(["https://s.test/x", true]));
      const user = userEvent.setup();
      render(<JobTree jobId="j" />);
      await user.click(await screen.findByRole("button", { name: "1 link" }));

      expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the API");
      await user.click(screen.getByRole("button", { name: /try again/i }));
      expect(await screen.findByText("https://s.test/x")).toBeTruthy();
    });

    it("says when only the first links are shown", async () => {
      reply(node("https://s.test/", { outgoingCount: 1200 }));
      getPageLinksMock.mockResolvedValue({ ...linksOf(["https://s.test/x", true]), total: 1200, truncated: true });
      const user = userEvent.setup();
      render(<JobTree jobId="j" />);
      await user.click(await screen.findByRole("button", { name: "1200 links" }));
      await waitFor(() => expect(screen.getByText(/1200 links, first 1 shown/)).toBeTruthy());
    });
  });

  describe("summary and controls", () => {
    it("summarizes the crawl above the tree", async () => {
      reply(
        node("https://s.test/", {
          domainLinkRatio: 0.8,
          outgoingCount: 5,
          children: [
            node("https://s.test/a", { depth: 1, domainLinkRatio: 0.4, outgoingCount: 5 }),
            node("https://s.test/gone", { depth: 1, status: "failed", domainLinkRatio: null, outgoingCount: null }),
          ],
        }),
      );
      render(<JobTree jobId="j" />);
      await screen.findByRole("list", { name: "Discovered pages" });
      const insight = (label: string) => screen.getByText(label).previousElementSibling?.textContent;
      expect(insight("Pages crawled")).toBe("2");
      expect(insight("Links found")).toBe("10");
      expect(insight("Avg. link ratio")).toBe("60%"); // (0.8 + 0.4) / 2
      expect(screen.getByText("2 crawled · 1 failed")).toBeTruthy();
    });

    it("collapses and expands every node with the toolbar", async () => {
      reply(node("https://s.test/", { outgoingCount: 1, children: [node("https://s.test/a", { depth: 1, outgoingCount: 1, children: [node("https://s.test/a/b", { depth: 2 })] })] }));
      const user = userEvent.setup();
      const { container } = render(<JobTree jobId="j" />);
      await screen.findByRole("list", { name: "Discovered pages" });
      const details = () => [...container.querySelectorAll("details")];
      expect(details().map((d) => d.open)).toEqual([true, true]); // root and depth 1 start open

      await user.click(screen.getByRole("button", { name: /collapse all/i }));
      expect(details().every((d) => !d.open)).toBe(true);

      await user.click(screen.getByRole("button", { name: /expand all/i }));
      expect(details().every((d) => d.open)).toBe(true);
    });
  });

  describe("filtering a page's links", () => {
    const open = async () => {
      reply(node("https://s.test/", { outgoingCount: 3 }));
      getPageLinksMock.mockResolvedValue({
        pageId: "https://s.test/",
        url: "https://s.test/",
        total: 3,
        truncated: false,
        links: [
          { url: "https://s.test/x", isInternal: true },
          { url: "https://s.test/y", isInternal: true },
          { url: "https://other.test/z", isInternal: false },
        ],
      });
      const user = userEvent.setup();
      render(<JobTree jobId="j" />);
      await user.click(await screen.findByRole("button", { name: "3 links" }));
      await screen.findByText("https://other.test/z");
      return user;
    };

    it("shows how many links each filter holds, and starts on all of them", async () => {
      await open();
      const group = within(screen.getByRole("group", { name: "Filter links" }));
      expect(group.getByRole("button", { name: /all 3/i }).getAttribute("aria-pressed")).toBe("true");
      expect(group.getByRole("button", { name: /internal 2/i })).toBeTruthy();
      expect(group.getByRole("button", { name: /external 1/i })).toBeTruthy();
    });

    it("narrows the list to internal or external links", async () => {
      const user = await open();
      await user.click(screen.getByRole("button", { name: /external 1/i }));
      expect(screen.getByText("https://other.test/z")).toBeTruthy();
      expect(screen.queryByText("https://s.test/x")).toBeNull();

      await user.click(screen.getByRole("button", { name: /internal 2/i }));
      expect(screen.getByText("https://s.test/x")).toBeTruthy();
      expect(screen.queryByText("https://other.test/z")).toBeNull();

      await user.click(screen.getByRole("button", { name: /all 3/i }));
      expect(screen.getByText("https://other.test/z")).toBeTruthy();
    });
  });
});
