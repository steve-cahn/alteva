import { isSameDomain } from "./url";

/**
 * Domain Link Ratio: internal links / total links, 0 when there are no links.
 *
 * A link is internal when its host equals `startHost`. `www.example.com` and `example.com`
 * are treated as the same host (in either direction); any other subdomain, such as
 * `blog.example.com`, counts as external.
 */
export function domainLinkRatio(links: string[], startHost: string): number {
  if (links.length === 0) return 0;
  const internal = links.filter((link) => isSameDomain(link, startHost)).length;
  return internal / links.length;
}
