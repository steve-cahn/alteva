import { describe, expect, it } from "vitest";
import { canonicalizeLink, originOf, outgoingLinks } from "../src";

const SITE = "https://example.com";

describe("originOf", () => {
  it("drops path, query and fragment, keeps scheme, host and non-default port", () => {
    expect(originOf("https://www.example.com/a/b?c=1#d")).toBe("https://www.example.com");
    expect(originOf("http://localhost:8080/x")).toBe("http://localhost:8080");
    expect(originOf("https://example.com:443/x")).toBe("https://example.com");
  });
});

describe("canonicalizeLink", () => {
  it.each([
    ["http://example.com/a", "https://example.com/a"],
    ["https://www.example.com/a", "https://example.com/a"],
    ["http://www.example.com/a?x=1", "https://example.com/a?x=1"],
    ["https://EXAMPLE.com/a", "https://example.com/a"],
    ["https://example.com/a", "https://example.com/a"],
  ])("rewrites %s to the site origin", (link, expected) => {
    expect(canonicalizeLink(link, SITE)).toBe(expected);
  });

  it("follows the site when it lives on www", () => {
    expect(canonicalizeLink("https://example.com/a", "https://www.example.com")).toBe("https://www.example.com/a");
    expect(canonicalizeLink("http://example.com/a", "https://www.example.com")).toBe("https://www.example.com/a");
  });

  it.each(["https://other.com/a", "https://blog.example.com/a", "https://example.com.evil.io/a"])(
    "leaves %s alone: a different host",
    (link) => {
      expect(canonicalizeLink(link, SITE)).toBe(link);
    },
  );

  it("leaves a different port alone: that is another server", () => {
    expect(canonicalizeLink("https://example.com:8443/a", SITE)).toBe("https://example.com:8443/a");
  });

  it("does not switch the scheme of a link on an explicit port", () => {
    expect(canonicalizeLink("http://localhost:8080/a", "https://localhost:8080")).toBe("http://localhost:8080/a");
    expect(canonicalizeLink("http://localhost:8080/a", "http://localhost:8080")).toBe("http://localhost:8080/a");
  });
});

describe("outgoingLinks", () => {
  const page = "https://example.com/page";

  it("drops links back to the page itself: anchors, repeats and other spellings of its address", () => {
    const links = ["https://example.com/page", "http://www.example.com/page", "https://example.com/other"];
    expect(outgoingLinks(links, [page], SITE)).toEqual(["https://example.com/other"]);
  });

  it("drops a link to the final URL after a redirect as well as the requested one", () => {
    const links = ["https://example.com/new", "https://example.com/old", "https://example.com/x"];
    expect(outgoingLinks(links, ["https://example.com/old", "https://example.com/new"], SITE)).toEqual(["https://example.com/x"]);
  });

  it("collapses spellings of the same page into one link, keeping document order", () => {
    const links = ["https://example.com/b", "http://example.com/a", "https://www.example.com/a", "https://example.com/a"];
    expect(outgoingLinks(links, [page], SITE)).toEqual(["https://example.com/b", "https://example.com/a"]);
  });

  it("keeps external links untouched, once each", () => {
    expect(outgoingLinks(["https://x.org/a", "https://x.org/a", "https://x.org/b"], [page], SITE)).toEqual(["https://x.org/a", "https://x.org/b"]);
  });

  it("returns nothing for a page whose only link points at itself", () => {
    expect(outgoingLinks(["https://example.com/page"], [page], SITE)).toEqual([]);
  });
});
