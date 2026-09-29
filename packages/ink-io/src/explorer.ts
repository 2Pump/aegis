import { getJson, type FetchLike } from './http.js';
import { TYDRO_TOKENS } from './logs.js';
import { backoffMs, sleep } from './rpc-errors.js';

/**
 * One-time Tydro seed from Ink's public explorer (Blockscout): the current holders of every aToken and
 * variableDebtToken = every wallet with a Tydro position right now. ~400 small requests instead of
 * scanning 37M blocks through a 1,000-block-capped RPC. The explorer only supplies ADDRESSES — every
 * balance, HF and pose is still read directly from the chain afterwards.
 */
export const INK_EXPLORER_API = 'https://explorer.inkonchain.com/api/v2';

interface HoldersPage {
  items?: Array<{ address?: { hash?: string }; value?: string }>;
  next_page_params?: Record<string, string | number> | null;
}

export interface SeedResult {
  /** holder → token indexes (into TYDRO_TOKENS) */
  users: Map<string, Set<number>>;
  pages: number;
  /** tokens whose holder list could not be fully read this time (failed, or the deadline came first) */
  failedTokens: number[];
  /** tokens whose holder list WAS fully read — lets the caller resume with the rest next run */
  done: number[];
  /** tokens the explorer answered 404 for (usually: never had a holder). The caller checks totalSupply on-chain. */
  notFound: number[];
}

export async function seedTydroHolders(o: {
  fetch?: FetchLike;
  base?: string;
  pageDelayMs?: number;
  backoffBaseMs?: number;
  deadline?: number;
  /** only these token indexes (default: all 28) — used to resume a seed that ran out of time */
  tokens?: readonly number[];
  onToken?: (tokenIndex: number, holders: number, pages: number) => void;
  onRetry?: (msg: string) => void;
} = {}): Promise<SeedResult> {
  const base = o.base ?? INK_EXPLORER_API;
  const users = new Map<string, Set<number>>();
  const failedTokens: number[] = [];
  const done: number[] = [];
  const notFound: number[] = [];
  let pages = 0;

  for (const ti of o.tokens ?? TYDRO_TOKENS.map((_, i) => i)) {
    const token = TYDRO_TOKENS[ti]!;
    let params: Record<string, string | number> | null = {};
    let holders = 0;
    let tokenPages = 0;
    let ok = true;
    while (params) {
      if (o.deadline && Date.now() > o.deadline) {
        ok = false;
        break;
      }
      const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)] as [string, string])).toString();
      const url = `${base}/tokens/${token}/holders${qs ? `?${qs}` : ''}`;
      let r = await getJson(url, undefined, { fetch: o.fetch, timeoutMs: 20_000 });
      // 404 "Not found" on the first page = the explorer has no holder list for this token (it never had a holder).
      // Retrying won't change that; hand it back so the caller can confirm on-chain.
      if (!r.ok && tokenPages === 0 && /HTTP 404/.test(r.error.message)) {
        notFound.push(ti);
        ok = false;
        break;
      }
      for (let attempt = 1; !r.ok && attempt <= 6; attempt++) {
        const wait = r.error.retryAfterS ? r.error.retryAfterS * 1000 : backoffMs(attempt, o.backoffBaseMs);
        o.onRetry?.(`explorer ${r.error.code} on token ${ti + 1}/28 page ${tokenPages + 1} — waiting ${Math.round(wait / 1000)}s (${r.error.message})`);
        await sleep(wait);
        r = await getJson(url, undefined, { fetch: o.fetch, timeoutMs: 20_000 });
      }
      if (!r.ok) {
        ok = false;
        break;
      }
      const page = r.value as HoldersPage;
      for (const it of page.items ?? []) {
        const h = it.address?.hash?.toLowerCase();
        if (!h || it.value === '0') continue;
        let set = users.get(h);
        if (!set) users.set(h, (set = new Set()));
        set.add(ti);
        holders++;
      }
      pages++;
      tokenPages++;
      params = page.next_page_params && Object.keys(page.next_page_params).length ? page.next_page_params : null;
      if (params && (o.pageDelayMs ?? 120) > 0) await sleep(o.pageDelayMs ?? 120);
    }
    if (!ok) {
      if (!notFound.includes(ti)) failedTokens.push(ti);
    } else done.push(ti);
    if (ok || tokenPages > 0) o.onToken?.(ti, holders, tokenPages);
  }
  return { users, pages, failedTokens, done, notFound };
}
