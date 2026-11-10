import { describe, expect, it } from "vitest";
import { comparableHost, isSameDomain, normalizeUrl } from "../src";

const base = "https://site.com/x/y";

describe("normalizeUrl", () => {
  describe("resolution", () => {
    it("resolves relative links against the base", () => {
      expect(normalizeUrl("/a", base)).toBe("https://site.com/a");
      expect(normalizeUrl("b.html", base)).toBe("https://site.com/x/b.html");
      expect(normalizeUrl("./b", base)).toBe("https://site.com/x/b");
      expect(normalizeUrl("../c", "https://site.com/x/y/")).toBe("https://site.com/x/c");
      expect(normalizeUrl("../../../../c", base)).toBe("https://site.com/c");
    });

    it("resolves query-only links against the base path", () => {
      expect(normalizeUrl("?page=2", "https://site.com/list")).toBe("https://site.com/list?page=2");
    });

    it("resolves protocol-relative links using the base scheme", () => {
      expect(normalizeUrl("//cdn.other.com/a", "https://site.com")).toBe("https://cdn.other.com/a");
      expect(normalizeUrl("//cdn.other.com/a", "http://site.com")).toBe("http://cdn.other.com/a");
    });

    it("passes absolute URLs through and ignores the base", () => {
      expect(normalizeUrl("http://other.com/a", base)).toBe("http://other.com/a");
    });

    it("trims surrounding whitespace from the href", () => {
      expect(normalizeUrl("  /a \n", base)).toBe("https://site.com/a");
    });
  });

  describe("fragments", () => {
    it("drops fragments so anchors map to the same page", () => {
      expect(normalizeUrl("/a#team", "https://site.com")).toBe("https://site.com/a");
      expect(normalizeUrl("#top", "https://site.com/a")).toBe("https://site.com/a");
      expect(normalizeUrl("https://site.com/a?q=1#x", base)).toBe("https://site.com/a?q=1");
    });

    it("treats a bare # as the current page", () => {
      expect(normalizeUrl("#", "https://site.com/a")).toBe("https://site.com/a");
    });
  });

  describe("host and port", () => {
    it("lowercases the host but not the path", () => {
      expect(normalizeUrl("https://SITE.com/CaSe")).toBe("https://site.com/CaSe");
    });

    it("lowercases the scheme", () => {
      expect(normalizeUrl("HTTPS://site.com/a")).toBe("https://site.com/a");
    });

    it("removes default ports and keeps non-default ones", () => {
      expect(normalizeUrl("https://site.com:443/a")).toBe("https://site.com/a");
      expect(normalizeUrl("http://site.com:80/a")).toBe("http://site.com/a");
      expect(normalizeUrl("https://site.com:80/a")).toBe("https://site.com:80/a");
      expect(normalizeUrl("http://site.com:8080/a")).toBe("http://site.com:8080/a");
    });

    it("keeps www as part of the host (www equivalence is a ratio concern, not a URL one)", () => {
      expect(normalizeUrl("https://www.site.com/a")).toBe("https://www.site.com/a");
    });
  });

  describe("trailing slash", () => {
    it("strips a trailing slash from non-root paths", () => {
      expect(normalizeUrl("/about/", "https://site.com")).toBe("https://site.com/about");
      expect(normalizeUrl("/a/b//", "https://site.com")).toBe("https://site.com/a/b");
    });

    it("maps /about and /about/ to the same URL", () => {
      expect(normalizeUrl("/about", "https://site.com")).toBe(normalizeUrl("/about/", "https://site.com"));
    });

    it("keeps the root path as a single slash, with or without one in the input", () => {
      expect(normalizeUrl("https://site.com")).toBe("https://site.com/");
      expect(normalizeUrl("https://site.com/")).toBe("https://site.com/");
      expect(normalizeUrl("https://site.com//")).toBe("https://site.com/");
    });

    it("keeps the query string and strips the slash before it", () => {
      expect(normalizeUrl("/a/?q=1", "https://site.com")).toBe("https://site.com/a?q=1");
    });
  });

  describe("rejected input", () => {
    it.each([
      "mailto:a@b.com",
      "tel:+123",
      "javascript:void(0)",
      "data:text/html,<h1>x</h1>",
      "ftp://site.com/file",
      "file:///etc/passwd",
      "sms:+123",
      "ws://site.com/socket",
      "blob:https://site.com/uuid",
      "JAVASCRIPT:alert(1)",
      "  mailto:a@b.com",
    ])("returns null for %s", (href) => {
      expect(normalizeUrl(href, "https://site.com")).toBeNull();
    });

    it("returns null for unparseable input and empty or missing bases", () => {
      expect(normalizeUrl("not a url")).toBeNull();
      expect(normalizeUrl("/relative-without-base")).toBeNull();
      expect(normalizeUrl("http://")).toBeNull();
    });

    it("resolves an empty href to the base page itself", () => {
      expect(normalizeUrl("", "https://site.com/a")).toBe("https://site.com/a");
    });
  });
});

describe("comparableHost / isSameDomain", () => {
  it("strips a leading www and lowercases", () => {
    expect(comparableHost("WWW.Site.com")).toBe("site.com");
    expect(comparableHost("site.com")).toBe("site.com");
  });

  it("only strips a leading www label", () => {
    expect(comparableHost("awww.site.com")).toBe("awww.site.com");
    expect(comparableHost("site.www.com")).toBe("site.www.com");
  });

  it("matches www and bare hosts in both directions", () => {
    expect(isSameDomain("https://www.site.com/a", "site.com")).toBe(true);
    expect(isSameDomain("https://site.com/a", "www.site.com")).toBe(true);
  });

  it("does not match other subdomains or lookalike hosts", () => {
    expect(isSameDomain("https://blog.site.com/a", "site.com")).toBe(false);
    expect(isSameDomain("https://site.com.evil.io/a", "site.com")).toBe(false);
  });
});
