/**
 * The brand, in one place. Every package that writes user-facing text (site, API, alerts, webhooks, share text)
 * takes the name, URL and disclaimer from here.
 *
 * Internal identifiers that still say `aegis` (package names `@aegis/*`, data `kind`s such as `aegis-history-agg`,
 * the API schema `aegis-api-1`, the ledger field `record.aegis`, storage keys, Blob paths, webhook header names)
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
 * Text recorded before the rebrand (historical ledger and parameter-change records keep their original wording)
 * shown with the current name. Display only — the stored records are never rewritten.
 */
export function brandText(s: string): string {
  return s.replace(/\bAEGIS\b/g, BRAND.display);
}
