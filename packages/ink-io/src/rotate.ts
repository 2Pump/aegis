import { createTransport, http, type EIP1193RequestFn, type Transport } from 'viem';
import { classifyRpcError, describeRpcError } from './rpc-errors.js';

/**
 * Ink's own public RPC endpoints, as listed on docs.inkonchain.com/tools/rpc (checked 2026-09-28).
 * Used by the census job when no INK_RPC is set, so one throttled provider doesn't stall the run.
 */
export const INK_PUBLIC_RPCS = [
  'https://rpc-gel.inkonchain.com', // Gelato
  'https://rpc-qnd.inkonchain.com', // QuickNode (public)
  'https://rpc-ten.inkonchain.com', // Tenderly
  'https://ink.drpc.org', // dRPC (public)
] as const;

/** "a,b , c" → ['a','b','c'] (also accepts whitespace/newlines) */
export function splitRpcList(s: string | undefined | null): string[] {
  return (s ?? '')
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Origin only, with any path (API keys live there) hidden. */
export function maskRpc(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.length > 1 ? '/…(key hidden)' : ''}`;
  } catch {
    return 'custom rpc';
  }
}

/** The node is a few blocks behind the block we asked for — another endpoint will have it. */
const BLOCK_LAG = /header not found|unknown block|block not found|missing trie node|block .*not (found|available)|after last accepted block/i;

export interface RotateStats {
  /** requests answered, per endpoint index */
  ok: number[];
  /** throttled / failed-over, per endpoint index */
  skipped: number[];
}

/**
 * Spreads requests round-robin over several endpoints of the SAME chain.
 *  - rate limit / timeout / 5xx on one endpoint → that endpoint rests `coolMs`, the request moves to the next
 *  - "request too big" → thrown straight back, so the log scanner shrinks its window exactly as with one RPC
 *  - a revert or other deterministic error → thrown straight back (another node would say the same)
 * With one endpoint this behaves like a plain http() transport.
 */
export function rotatingTransport(transports: readonly Transport[], opts: { coolMs?: number; stats?: RotateStats } = {}): Transport {
  const coolMs = opts.coolMs ?? 20_000;
  const n = transports.length;
  const coolUntil = new Array<number>(n).fill(0);
  let next = 0;
  return ({ chain, pollingInterval, timeout, ...rest }) => {
    const inst = transports.map((t) => t({ chain, pollingInterval, timeout, ...rest, retryCount: 0 }));
    return createTransport({
      key: 'ink-rotate',
      name: 'Ink rotating RPC',
      type: 'ink-rotate',
      retryCount: 0,
      request: (async ({ method, params }: { method: string; params?: unknown }) => {
        const start = next;
        next = (next + 1) % n;
        const now = Date.now();
        // ready endpoints first (round-robin order), then the ones resting, soonest-ready first
        const order = Array.from({ length: n }, (_, k) => (start + k) % n);
        const ready = order.filter((i) => coolUntil[i]! <= now);
        const resting = order.filter((i) => coolUntil[i]! > now).sort((a, b) => coolUntil[a]! - coolUntil[b]!);
        let last: unknown;
        for (const i of [...ready, ...resting]) {
          try {
            const r = await inst[i]!.request({ method, params } as never);
            if (opts.stats) opts.stats.ok[i] = (opts.stats.ok[i] ?? 0) + 1;
            return r;
          } catch (e) {
            last = e;
            const kind = classifyRpcError(e);
            const lag = BLOCK_LAG.test(describeRpcError(e));
            if (kind === 'size' || (kind === 'other' && !lag)) throw e;
            if (!lag) coolUntil[i] = Date.now() + coolMs;
            if (opts.stats) opts.stats.skipped[i] = (opts.stats.skipped[i] ?? 0) + 1;
          }
        }
        throw last;
      }) as EIP1193RequestFn,
    });
  };
}

export function rotatingHttp(urls: readonly string[], opts: { timeoutMs?: number; coolMs?: number; stats?: RotateStats } = {}): Transport {
  const ts = urls.map((u) => http(u, { timeout: opts.timeoutMs ?? 10_000, retryCount: 0 }));
  return rotatingTransport(ts, opts);
}
