import * as cheerio from "cheerio";
import { normalizeUrl } from "./url";

/**
 * Unique, normalized http(s) links found in `<a href>` and `<area href>` (image maps), in document
 * order. Relative links resolve against the page's `<base href>` when it has one, as a browser
 * would, and against the page URL otherwise.
 */
export function extractLinks(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html);
  const base = baseUrlOf($, pageUrl);
  const links = new Set<string>();
  $("a[href], area[href]").each((_, el) => {
    const normalized = normalizeUrl($(el).attr("href") ?? "", base);
    if (normalized) links.add(normalized);
  });
  return [...links];
}

/**
 * The URL relative links resolve against. The first `<base href>` wins (per the HTML spec); a
 * missing, empty, unparseable or non-http(s) one is ignored. Resolved with `new URL`, not
 * `normalizeUrl`, which would strip the trailing slash that makes `/a/` a directory.
 */
function baseUrlOf($: cheerio.CheerioAPI, pageUrl: string): string {
  const href = $("base[href]").first().attr("href")?.trim();
  if (!href) return pageUrl;
  try {
    const base = new URL(href, pageUrl);
    return base.protocol === "http:" || base.protocol === "https:" ? base.href : pageUrl;
  } catch {
    return pageUrl;
  }
}
