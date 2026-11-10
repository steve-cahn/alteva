import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { domainLinkRatio, extractLinks } from "../src";

const html = readFileSync(new URL("./fixtures/home.html", import.meta.url), "utf8");

describe("extractLinks (fixture)", () => {
  const links = extractLinks(html, "https://site.com/");

  it("keeps only unique, normalized http(s) links", () => {
    expect(links).toEqual([
      "https://site.com/about",
      "https://site.com/contact.html",
      "https://other.com/x",
      "https://site.com/",
    ]);
  });

  it("feeds the domain link ratio", () => {
    expect(domainLinkRatio(links, "site.com")).toBe(0.75);
  });
});

describe("extractLinks", () => {
  const extract = (body: string, page = "https://site.com/dir/page") => extractLinks(body, page);

  it("returns an empty list for empty or link-free HTML", () => {
    expect(extract("")).toEqual([]);
    expect(extract("<p>no links</p>")).toEqual([]);
  });

  it("resolves relative links against the page URL", () => {
    expect(extract('<a href="x">a</a><a href="../y">b</a><a href="/z">c</a>')).toEqual([
      "https://site.com/dir/x",
      "https://site.com/y",
      "https://site.com/z",
    ]);
  });

  it("resolves protocol-relative links", () => {
    expect(extract('<a href="//cdn.other.com/a">a</a>')).toEqual(["https://cdn.other.com/a"]);
  });

  it("dedupes links that differ only by fragment, trailing slash or host case", () => {
    const body = `
      <a href="/a">1</a><a href="/a#x">2</a><a href="/a/">3</a>
      <a href="HTTPS://SITE.com:443/a">4</a>`;
    expect(extract(body)).toEqual(["https://site.com/a"]);
  });

  it("keeps links that differ by query string", () => {
    expect(extract('<a href="/a?p=1">1</a><a href="/a?p=2">2</a>')).toEqual([
      "https://site.com/a?p=1",
      "https://site.com/a?p=2",
    ]);
  });

  it("drops non-http(s) schemes", () => {
    const body = `
      <a href="mailto:a@b.com">m</a><a href="tel:+1">t</a><a href="javascript:void(0)">j</a>
      <a href="data:text/plain,hi">d</a><a href="ftp://site.com/f">f</a>`;
    expect(extract(body)).toEqual([]);
  });

  it("ignores anchors without href and empty hrefs resolve to the page itself", () => {
    expect(extract('<a name="x">n</a><a>none</a><a href="">self</a>')).toEqual(["https://site.com/dir/page"]);
  });

  it("reads <a> and <area> (image map) links, but not link, img or script tags", () => {
    const body = `
      <link rel="stylesheet" href="/s.css"><img src="/i.png"><script src="/s.js"></script>
      <map name="m"><area href="/map" shape="rect" coords="0,0,1,1"></map><a href="/real">r</a>`;
    expect(extract(body)).toEqual(["https://site.com/map", "https://site.com/real"]);
  });

  it("tolerates malformed HTML", () => {
    expect(extract('<div><a href="/a">open <b>unclosed<a href="/b">next')).toEqual([
      "https://site.com/a",
      "https://site.com/b",
    ]);
  });

  describe("<base href>", () => {
    it("resolves relative links against a base directory, keeping its trailing slash", () => {
      expect(extract('<base href="/a/"><a href="1">x</a><a href="../c">y</a>', "https://site.com/other")).toEqual([
        "https://site.com/a/1",
        "https://site.com/c",
      ]);
    });

    it("leaves root-relative and absolute links alone", () => {
      expect(extract('<base href="/a/"><a href="/root">r</a><a href="https://x.org/p">e</a>')).toEqual([
        "https://site.com/root",
        "https://x.org/p",
      ]);
    });

    it("accepts an absolute base, even on another host", () => {
      expect(extract('<base href="https://cdn.site.com/docs/"><a href="guide">g</a>')).toEqual(["https://cdn.site.com/docs/guide"]);
    });

    it("resolves a relative base against the page URL", () => {
      expect(extract('<base href="sub/"><a href="p">p</a>', "https://site.com/dir/page")).toEqual(["https://site.com/dir/sub/p"]);
    });

    it("uses the first <base> only", () => {
      expect(extract('<base href="/one/"><base href="/two/"><a href="x">x</a>')).toEqual(["https://site.com/one/x"]);
    });

    it.each([
      ["a base with only a target", '<base target="_blank">'],
      ["an empty base href", '<base href="">'],
      ["a blank base href", '<base href="   ">'],
      ["a javascript: base", '<base href="javascript:void(0)">'],
      ["a mailto: base", '<base href="mailto:a@b.com">'],
      ["an unparseable base", '<base href="http://">'],
    ])("ignores %s and falls back to the page URL", (_name, base) => {
      expect(extract(`${base}<a href="x">x</a>`, "https://site.com/dir/page")).toEqual(["https://site.com/dir/x"]);
    });
  });
});
