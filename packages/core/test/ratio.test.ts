import { describe, expect, it } from "vitest";
import { domainLinkRatio } from "../src";

describe("domainLinkRatio", () => {
  it("is 0 when there are no links", () => {
    expect(domainLinkRatio([], "site.com")).toBe(0);
  });

  it("is internal links divided by total links", () => {
    const links = ["https://site.com/a", "https://site.com/b", "https://other.com/c", "https://x.org/"];
    expect(domainLinkRatio(links, "site.com")).toBe(0.5);
    expect(domainLinkRatio([...links.slice(0, 1), ...links.slice(2)], "site.com")).toBeCloseTo(1 / 3);
  });

  it("is 1 when every link is internal and 0 when none are", () => {
    expect(domainLinkRatio(["https://site.com/a"], "site.com")).toBe(1);
    expect(domainLinkRatio(["https://other.com/a"], "site.com")).toBe(0);
  });

  it("treats www.example.com and example.com as the same host", () => {
    const links = ["https://www.site.com/a", "https://site.com/b", "https://other.com/"];
    expect(domainLinkRatio(links, "site.com")).toBeCloseTo(2 / 3);
    expect(domainLinkRatio(links, "www.site.com")).toBeCloseTo(2 / 3);
  });

  it("treats other subdomains as a different host", () => {
    expect(domainLinkRatio(["https://blog.site.com/a"], "site.com")).toBe(0);
  });

  it("ignores scheme and port when comparing hosts", () => {
    expect(domainLinkRatio(["http://site.com/a", "https://site.com:8443/b"], "site.com")).toBe(1);
  });

  it("is case-insensitive on the start host", () => {
    expect(domainLinkRatio(["https://site.com/a"], "SITE.com")).toBe(1);
  });
});
