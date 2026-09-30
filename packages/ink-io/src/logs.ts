import { toEventSelector, type Address, type Log, type PublicClient } from 'viem';
import { NADO_CONTRACTS } from './nado-registry.js';
import { backoffMs, classifyRpcError, describeRpcError, sleep, type RpcErrorKind } from './rpc-errors.js';
import { TYDRO_RESERVES } from './tydro-registry.js';

/**
 * On-chain discovery. Every wallet AEGIS knows about came from one of these public events — nothing is scraped,
 * nothing comes from a third-party list.
 *
 *  Tydro  — ERC-20 Transfer on every aToken and variableDebtToken (mint = supply/borrow, burn = withdraw/repay/liquidation).
 *  Nado   — Clearinghouse.ModifyCollateral(int128 amount, bytes32 indexed subaccount, uint32 productId)   (deposits/withdrawals)
 *           Clearinghouse.Liquidation(bytes32 indexed liquidator, bytes32 indexed liquidatee, …)
 *           SpotEngine/PerpEngine.BalanceUpdate(uint32 productId, bytes32 subaccount)                  (every trade; not indexed)
 * Event shapes: nadohq/nado-typescript-sdk @7a326cb abis; Aave v3 IERC20 Transfer.
 */
export const TOPIC = {
  transfer: toEventSelector('Transfer(address,address,uint256)'),
  modifyCollateral: toEventSelector('ModifyCollateral(int128,bytes32,uint32)'),
  liquidation: toEventSelector('Liquidation(bytes32,bytes32,uint32,bool,int128,int128)'),
  balanceUpdate: toEventSelector('BalanceUpdate(uint32,bytes32)'),
} as const;

export const TYDRO_START_BLOCK = 19_954_047; // Pool proxy creation tx 0x0320…3c40 (Blockscout, 2025-07-25)
export const NADO_START_BLOCK = 29_851_015; // SDK deployment.inkMainnet.json startBlock

/** Every Tydro aToken (even index) and variableDebtToken (odd index). Index is stable: reserve i → 2i, 2i+1. */
export const TYDRO_TOKENS: readonly Address[] = TYDRO_RESERVES.flatMap((r) => [r.aToken, r.vToken]);
const TYDRO_TOKEN_INDEX = new Map(TYDRO_TOKENS.map((t, i) => [t.toLowerCase(), i]));

const ZERO = '0x0000000000000000000000000000000000000000';
const topicAddr = (t: string | undefined) => (t ? (`0x${t.slice(26)}` as const).toLowerCase() : null);
const topicBytes32 = (t: string | undefined) => (t ? (t.toLowerCase() as `0x${string}`) : null);

/* ───────────────────────── adaptive getLogs ───────────────────────── */

/**
 * Block-range cap learned from an RPC's own error text (e.g. "block range greater than 1000 max").
 * Shared by every scan in this process — the census job and the browser live layer learn it once.
 */
let learnedMaxSpan = Infinity;
export const getLearnedMaxSpan = () => learnedMaxSpan;
export const resetLearnedMaxSpan = () => {
  learnedMaxSpan = Infinity;
};

/** Pull an explicit block-range limit out of an RPC error, if it states one. */
export function parseRangeLimit(error: string): number | null {
  const t = error.toLowerCase();
  if (!/block|range/.test(t)) return null;
  const m =
    t.match(/(?:greater than|more than|exceeds?|over|maximum(?: of)?|max(?:imum)?(?: block range)?(?: is| of)?|limit(?: is| of)?|up to(?: a)?)\s*([\d,]+)\s*(k)?\s*(?:max|blocks?|block range)?/) ??
    t.match(/([\d,]+)\s*(k)?\s*(?:max|blocks? max|block limit)/);
  if (!m) return null;
  let n = Number(m[1]!.replace(/,/g, ''));
  if (m[2]) n *= 1000;
  return Number.isFinite(n) && n >= 10 ? n : null;
}

export interface ScanProgress {
  from: number;
  to: number;
  logs: number;
  span: number;
}

export interface ScanOpts {
  address: Address | Address[];
  topics: (`0x${string}` | `0x${string}`[] | null)[];
  fromBlock: number;
  toBlock: number;
  /** starting window; shrinks on size errors, grows on success */
  initialSpan?: number;
  maxSpan?: number;
  minSpan?: number;
  /** stop early (resume later) once this wall-clock deadline passes */
  deadline?: number;
  /** pause between successful requests, to stay under free-RPC rate limits */
  paceMs?: number;
  /** consecutive failed attempts (after waiting) before pausing the scan */
  maxRetries?: number;
  /** first backoff wait (doubles each retry, capped at 30×). Default 1000 ms. */
  backoffBaseMs?: number;
  onProgress?: (p: ScanProgress) => void;
  onRetry?: (info: { attempt: number; kind: RpcErrorKind; waitMs: number; span: number; error: string }) => void;
  /** called once when the RPC states its block-range cap */
  onLimit?: (maxBlocks: number) => void;
}

export interface ScanResult {
  logs: Log[];
  /** last block fully scanned (== toBlock when complete) */
  scannedTo: number;
  complete: boolean;
  errors: number;
  /** why the scan stopped early, if it did */
  stoppedBecause?: string;
}

/**
 * getLogs over a large range. Never throws; always returns how far it got so the caller can save and resume.
 *  - SIZE errors (range/result limits) → halve the window, and never grow back past a size that failed
 *  - SLOW errors (429, timeouts, generic failures) → same window, wait 1s/2s/4s/…/30s
 *  - still failing after maxRetries → stop here and report why (progress so far is kept)
 */
export async function scanLogs(client: PublicClient, o: ScanOpts): Promise<ScanResult> {
  const minSpan = o.minSpan ?? 10;
  const maxSpan = o.maxSpan ?? 200_000;
  const maxRetries = o.maxRetries ?? 8;
  const pace = o.paceMs ?? 60;
  let ceiling = Math.min(maxSpan, learnedMaxSpan);
  let span = Math.min(o.initialSpan ?? 5_000, ceiling);
  let from = o.fromBlock;
  const logs: Log[] = [];
  let errors = 0;
  let attempt = 0;
  while (from <= o.toBlock) {
    if (o.deadline && Date.now() > o.deadline) return { logs, scannedTo: from - 1, complete: false, errors, stoppedBecause: 'time budget reached' };
    const to = Math.min(from + span - 1, o.toBlock);
    try {
      const got = await client.request({
        method: 'eth_getLogs',
        params: [{ address: o.address, topics: o.topics, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
      } as never);
      const arr = got as unknown as Log[];
      logs.push(...arr);
      o.onProgress?.({ from, to, logs: arr.length, span });
      from = to + 1;
      attempt = 0;
      if (arr.length < 5_000) span = Math.min(ceiling, Math.ceil(span * 1.5));
      if (pace > 0 && from <= o.toBlock) await sleep(pace);
    } catch (e) {
      errors++;
      attempt++;
      const error = describeRpcError(e);
      let kind = classifyRpcError(e);
      // unknown errors: treat as slow first, then as size if they keep happening
      if (kind === 'other') kind = attempt >= 3 ? 'size' : 'slow';
      if (attempt > maxRetries || (kind === 'size' && span <= minSpan && attempt > 3)) {
        return { logs, scannedTo: from - 1, complete: false, errors, stoppedBecause: `RPC kept failing at block ${from} (${kind === 'size' ? 'even with tiny windows' : 'after waiting'}): ${error}` };
      }
      let waitMs = 0;
      if (kind === 'size') {
        const stated = parseRangeLimit(error);
        if (stated && stated < ceiling) {
          // the RPC told us its cap: use exactly that, forever, and don't count it as a real failure
          ceiling = stated;
          span = stated;
          if (stated < learnedMaxSpan) {
            learnedMaxSpan = stated;
            o.onLimit?.(stated);
          }
          attempt = 0;
          errors--;
          continue;
        }
        ceiling = Math.max(minSpan, Math.min(ceiling, Math.floor(span * 0.75)));
        span = Math.max(minSpan, Math.min(ceiling, Math.floor(span / 2)));
        if (attempt > 2) waitMs = 500;
      } else {
        waitMs = backoffMs(attempt, o.backoffBaseMs);
      }
      o.onRetry?.({ attempt, kind, waitMs, span, error });
      if (waitMs) await sleep(waitMs);
    }
  }
  return { logs, scannedTo: o.toBlock, complete: true, errors };
}

/* ───────────────────────── decoders ───────────────────────── */

/** Tydro: holder address → set of token indexes they have touched. */
export function decodeTydroTransfers(logs: readonly Log[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const l of logs) {
    if (l.topics[0] !== TOPIC.transfer) continue;
    const idx = TYDRO_TOKEN_INDEX.get((l.address ?? '').toLowerCase());
    if (idx === undefined) continue;
    for (const a of [topicAddr(l.topics[1]), topicAddr(l.topics[2])]) {
      if (!a || a === ZERO) continue;
      if (TYDRO_TOKEN_INDEX.has(a)) continue; // token contracts themselves
      let s = out.get(a);
      if (!s) out.set(a, (s = new Set()));
      s.add(idx);
    }
  }
  return out;
}

/** Nado: every subaccount (bytes32) mentioned by ModifyCollateral, Liquidation or BalanceUpdate. */
export function decodeNadoSubaccounts(logs: readonly Log[]): Set<`0x${string}`> {
  const all = decodeNadoSubaccountsAll(logs);
  for (const s of [...all]) if (isProtocolSub(s)) all.delete(s); // protocol/zero-owner subaccounts
  return all;
}

/** Protocol-owned subaccounts (zero owner: fees, liquidity and similar engine accounts). Not wallets — never drawn. */
export const isProtocolSub = (s: string) => /^0x0{40}/i.test(s);

/**
 * Protocol subaccounts seen in logs, plus Vertex's fixed ones (FEES_ACCOUNT = 0, X_ACCOUNT = 1, V_ACCOUNT = 2 in
 * vertex-contracts core/contracts/common/Constants.sol; Nado is a Vertex fork). Read for coverage only.
 */
export const VERTEX_PROTOCOL_SUBS: readonly `0x${string}`[] = [0, 1, 2].map((n) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`);
export function decodeNadoProtocolSubaccounts(logs: readonly Log[]): Set<`0x${string}`> {
  return new Set([...decodeNadoSubaccountsAll(logs)].filter(isProtocolSub));
}

function decodeNadoSubaccountsAll(logs: readonly Log[]): Set<`0x${string}`> {
  const out = new Set<`0x${string}`>();
  for (const l of logs) {
    const t0 = l.topics[0];
    if (t0 === TOPIC.modifyCollateral) {
      const s = topicBytes32(l.topics[1]);
      if (s) out.add(s);
    } else if (t0 === TOPIC.liquidation) {
      for (const t of [l.topics[1], l.topics[2]]) {
        const s = topicBytes32(t);
        if (s) out.add(s);
      }
    } else if (t0 === TOPIC.balanceUpdate) {
      // data = abi.encode(uint32 productId, bytes32 subaccount)
      const d = (l.data ?? '0x').slice(2);
      if (d.length >= 128) out.add(`0x${d.slice(64, 128)}`.toLowerCase() as `0x${string}`);
    }
  }
  return out;
}

export const subaccountOwner = (sub: string) => sub.slice(0, 42).toLowerCase();

/* ───────────────────────── convenience scanners ───────────────────────── */

export function scanTydro(client: PublicClient, fromBlock: number, toBlock: number, o: Partial<ScanOpts> = {}) {
  return scanLogs(client, { ...o, address: [...TYDRO_TOKENS], topics: [TOPIC.transfer], fromBlock, toBlock });
}

/** Backfill-friendly: deposits + liquidations only (low volume). */
export function scanNadoAccounts(client: PublicClient, fromBlock: number, toBlock: number, o: Partial<ScanOpts> = {}) {
  return scanLogs(client, { ...o, address: NADO_CONTRACTS.clearinghouse, topics: [[TOPIC.modifyCollateral, TOPIC.liquidation]], fromBlock, toBlock });
}

/** Every trade too (high volume) — only for short windows (hourly incremental, live layer). */
export function scanNadoActivity(client: PublicClient, fromBlock: number, toBlock: number, o: Partial<ScanOpts> = {}) {
  return scanLogs(client, {
    ...o,
    address: [NADO_CONTRACTS.clearinghouse, NADO_CONTRACTS.spotEngine, NADO_CONTRACTS.perpEngine],
    topics: [[TOPIC.modifyCollateral, TOPIC.liquidation, TOPIC.balanceUpdate]],
    fromBlock,
    toBlock,
  });
}
