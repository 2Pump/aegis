/**
 * The brand, in one place. Every package that writes user-facing text (site, API, alerts, webhooks, share text)
 * takes the name, URL and disclaimer from here.
 *
 * Internal identifiers that still say `aegis` (package names `@aegis/*`, data `kind`s such as `aegis-history-agg`,
 * the ledger field `record.aegis`, storage keys, Blob paths)
 * are data contracts, not branding — see docs/BRAND.md "Legacy identifiers" before renaming any of them.
 */
export const BRAND = {
  /** wordmark, titles and all-caps labels */
  name: 'PHROURAX',
  /** in sentences */
  display: 'Phrourax',
  siteUrl: 'https://phrourax.com',
  category: 'On-chain risk intelligence',
  tagline: 'See risk before it moves.',
  shortDescription:
    'On-chain risk intelligence for Ink. Monitor positions, liquidation pressure, oracle conditions, and protocol changes across Tydro and Nado. Read-only. Cannot move funds.',
  disclaimer: 'Phrourax is read-only. It never connects to your wallet and cannot move funds. Classifications may be incomplete or incorrect. Not financial advice.',
  safety: 'Phrourax never connects to a wallet, requests private keys, signs transactions, or moves funds.',
} as const;

/**
 * Human-readable text recorded before the rebrand (historical ledger, parameter-change and check records keep their
 * original wording) shown with the current name: AEGIS → PHROURAX, Aegis → Phrourax. Display only — the stored
 * records are never rewritten. Lowercase identifiers (`aegis-…` kinds, `record.aegis`, storage keys) never match.
 */
export function brandText(s: string): string {
  return s.replace(/\bAEGIS\b/g, BRAND.name).replace(/\bAegis\b/g, BRAND.display);
}

/** True when text (e.g. a raw JSON file) holds a legacy brand word worth translating. */
export const hasLegacyBrand = (s: string): boolean => /\bAEGIS\b|\bAegis\b/.test(s);

/** brandText on every string VALUE of a parsed JSON document (keys are never touched). Returns a new value. */
export function brandJson<T>(x: T): T {
  if (typeof x === 'string') return brandText(x) as T;
  if (Array.isArray(x)) return x.map((v) => brandJson(v)) as T;
  if (x && typeof x === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) o[k] = brandJson(v);
    return o as T;
  }
  return x;
}

/**
 * Plans (docs/PAYWALL.md). Prices are per 30-day period, paid in crypto (stage 3: NOWPayments). Change them here only.
 */
export const PLANS = {
  pro: {
    name: 'Pro',
    usd: 19,
    blurb: 'The whole site.',
    features: ['Everything on the site: Well, Pressure, Intel, Scan', 'Full wallet detail, history and stress test', 'Telegram alerts for up to 10 wallets'],
  },
  desk: {
    name: 'Desk',
    usd: 99,
    blurb: 'The site plus the API.',
    features: ['Everything in Pro', 'The full API, plus webhooks (when they open)', 'Telegram alerts for up to 100 wallets'],
  },
  free: {
    name: 'Free',
    usd: 0,
    blurb: 'Check one wallet at a time.',
    features: ["Any wallet's risk level and position types", 'Share links and cards', 'The rules, Checks and the public track record'],
  },
  PERIOD_DAYS: 30,
} as const;
