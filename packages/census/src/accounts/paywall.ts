/**
 * What is free and what needs a plan (docs/PAYWALL.md). Pure.
 *
 * Off (PAYWALL unset): everything is served to everyone, exactly as before.
 * On (PAYWALL=1):
 *   free   — a wallet's risk level and types (read live from the chain in the browser), share links and cards,
 *            the rules, Checks (verification log, track record), and the API's /, /openapi.json, /status,
 *            /wallets/{address}, /performance, /verification
 *   Pro    — the whole site: Well, Pressure, Intel, Scan, full wallet detail and history
 *   Desk   — Pro, plus the rest of the API
 * Complimentary accounts (COMP_EMAILS, e.g. the owner) count as Desk.
 */
import { access, type Access, type User } from './core.js';

/** census files anyone may read (the Checks page and the free wallet page) */
const FREE_FILES = new Set(['verification-log.json', 'history/accountability.json', 'history/forecast-score.json']);
export const isFreeFile = (name: string): boolean => FREE_FILES.has(name);

/** a census file name the data route will serve at all (never a URL, never ..) */
export const isDataFileName = (name: string): boolean => /^[a-z0-9][a-z0-9/_.-]*\.json$/i.test(name) && !name.includes('..') && !name.includes('//') && name !== 'known.json';

const FREE_API = [/^\/$/, /^\/openapi\.json$/, /^\/status$/, /^\/wallets\/[^/]+$/, /^\/performance$/, /^\/verification$/];
export const isFreeApiPath = (path: string): boolean => FREE_API.some((r) => r.test(path.replace(/\/+$/, '') || '/'));

export const parseComp = (raw: string | undefined): ReadonlySet<string> =>
  new Set((raw ?? '').split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean));

/** the plan that counts right now, complimentary accounts included */
export function effectiveAccess(u: User | null, nowMs: number, comp: ReadonlySet<string> = new Set()): Access {
  if (u && comp.has(u.email)) return 'desk';
  return access(u, nowMs);
}

export const siteUnlocked = (a: Access): boolean => a === 'pro' || a === 'desk';
export const apiUnlocked = (a: Access): boolean => a === 'desk';

export const PAYMENT_REQUIRED = {
  site: 'Subscribers only — see plans at /pricing.',
  api: 'This endpoint needs the Desk plan — see /pricing.',
} as const;
