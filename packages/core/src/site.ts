import { comparableHost } from "./url";

/** `https://www.example.com:8443/a?b` -> `https://www.example.com:8443`. */
export function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * Rewrites a link that points at the crawled site to the site's canonical origin, so that
 * `http://site.com/a`, `https://site.com/a` and `https://www.site.com/a` are one page, not three.
 *
 * "At the site" means the same host ignoring a leading `www.` and the same port. Links to other
 * hosts, and to the same host on a different port (a different server), are returned unchanged.
 */
export function canonicalizeLink(link: string, siteOrigin: string): string {
  const url = new URL(link);
  const site = new URL(siteOrigin);
  if (comparableHost(url.hostname) !== comparableHost(site.hostname) || url.port !== site.port) return link;
  // An explicit non-default port means a specific server: do not switch its scheme.
  if (url.port !== "" && url.protocol !== site.protocol) return link;
  url.protocol = site.protocol;
  url.host = site.host;
  return url.href;
}

/**
 * The outgoing links of a page, as counted for the Domain Link Ratio and stored as edges:
 * internal links canonicalized to the site origin, links back to the page itself dropped (an
 * in-page anchor such as `#top` is navigation within the page, not an outgoing link), and
 * duplicates collapsed. Document order is kept.
 *
 * `pageUrls` are the addresses the page is known by (the requested URL and, after redirects, the
 * final one).
 */
export function outgoingLinks(links: string[], pageUrls: string[], siteOrigin: string): string[] {
  const self = new Set(pageUrls.map((url) => canonicalizeLink(url, siteOrigin)));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const link of links) {
    const canonical = canonicalizeLink(link, siteOrigin);
    if (self.has(canonical) || seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(canonical);
  }
  return result;
}
