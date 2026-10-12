/**
 * Vercel Web Analytics: anonymous page-view counts, no cookies.
 * Before anything leaves the browser, the page address is cleaned up:
 *   - wallet addresses are replaced with [address], so nobody (Vercel included) learns which wallets people look up;
 *   - anything after ? or # is dropped (sign-in links carry their token after #).
 */
export function scrubUrl(href: string): string {
  const u = new URL(href);
  const path = u.pathname.replace(/0x[0-9a-fA-F]{40}/g, '[address]');
  return `${u.origin}${path}`;
}

export const beforeSend = <E extends { url: string }>(event: E): E => ({ ...event, url: scrubUrl(event.url) });
