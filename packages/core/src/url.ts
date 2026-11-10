const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Resolves `raw` against `base` (relative and protocol-relative links included) and returns a
 * canonical absolute URL, or null for non-http(s) schemes (mailto:, tel:, javascript:, data:, ...)
 * and unparseable input.
 *
 * The WHATWG URL parser already lowercases the scheme and host and drops default ports (:80 for
 * http, :443 for https). On top of that we:
 *  - strip the fragment, so anchors map to the page they live on;
 *  - strip a trailing slash from non-root paths, so `/about` and `/about/` are one page.
 *    The root path stays `/`. Query strings are kept as they are: they can change the content.
 */
export function normalizeUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (!HTTP_PROTOCOLS.has(url.protocol)) return null;
  url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.href;
}

export function hostOf(url: string): string {
  return new URL(url).hostname;
}

/**
 * Host used for internal/external comparison: lowercased, with a leading `www.` removed, so
 * `www.example.com` and `example.com` are the same site. Other subdomains stay distinct.
 */
export function comparableHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

export function isSameDomain(url: string, startHost: string): boolean {
  return comparableHost(hostOf(url)) === comparableHost(startHost);
}
