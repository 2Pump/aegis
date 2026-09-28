import type { PublicClient } from 'viem';
import { errMessage } from './result.js';
import { backoffMs, classifyRpcError, describeRpcError, sleep } from './rpc-errors.js';

/**
 * Multicall a long list of read calls in self-sizing chunks. RPC nodes cap eth_call gas and response size,
 * so a chunk that fails as a whole is halved and retried; a single call that still fails is reported as failed
 * (never silently dropped, never filled in).
 */
export interface Call {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

export type CallResult = { ok: true; value: unknown } | { ok: false; error: string };

export interface BatchOpts {
  blockNumber?: bigint;
  chunk?: number;
  minChunk?: number;
  concurrency?: number;
  onChunk?: (done: number, total: number, chunk: number) => void;
  /** called when a chunk hits a rate limit / timeout and we wait before retrying */
  onRetry?: (info: { attempt: number; waitMs: number; error: string }) => void;
  /** waits for rate-limit/timeouts before a chunk is marked failed */
  maxRetries?: number;
  backoffBaseMs?: number;
}

export async function multicallAdaptive(client: PublicClient, calls: readonly Call[], o: BatchOpts = {}): Promise<CallResult[]> {
  const out: CallResult[] = new Array(calls.length);
  let chunk = Math.max(1, o.chunk ?? 200);
  const minChunk = o.minChunk ?? 1;
  let i = 0;
  let done = 0;

  const maxRetries = o.maxRetries ?? 6;
  const runOne = async (start: number, size: number, attempt = 0): Promise<boolean> => {
    const slice = calls.slice(start, start + size);
    try {
      const res = await client.multicall({
        contracts: slice as never,
        allowFailure: true,
        blockNumber: o.blockNumber,
        batchSize: 0, // we already chunk; let viem send one aggregate3
      } as never);
      (res as Array<{ status: 'success' | 'failure'; result?: unknown; error?: unknown }>).forEach((r, k) => {
        out[start + k] = r.status === 'success' ? { ok: true, value: r.result } : { ok: false, error: errMessage(r.error) };
      });
      return true;
    } catch (e) {
      // rate limit / timeout: same size, wait, retry — shrinking would only mean more requests
      if (classifyRpcError(e) === 'slow' && attempt < maxRetries) {
        const waitMs = backoffMs(attempt + 1, o.backoffBaseMs);
        o.onRetry?.({ attempt: attempt + 1, waitMs, error: describeRpcError(e) });
        await sleep(waitMs);
        return runOne(start, size, attempt + 1);
      }
      if (size <= minChunk) {
        for (let k = 0; k < slice.length; k++) out[start + k] = { ok: false, error: describeRpcError(e) || errMessage(e) };
        return true;
      }
      return false;
    }
  };

  const conc = Math.max(1, o.concurrency ?? 2);
  while (i < calls.length) {
    const starts: Array<[number, number]> = [];
    for (let c = 0; c < conc && i < calls.length; c++) {
      const size = Math.min(chunk, calls.length - i);
      starts.push([i, size]);
      i += size;
    }
    const results = await Promise.all(starts.map(([s, n]) => runOne(s, n)));
    let failedAny = false;
    for (let k = 0; k < starts.length; k++) {
      const [s, n] = starts[k]!;
      if (results[k]) {
        done += n;
        continue;
      }
      failedAny = true;
      // retry this slice with smaller chunks, sequentially
      let j = s;
      let small = Math.max(minChunk, Math.floor(n / 2));
      while (j < s + n) {
        const size = Math.min(small, s + n - j);
        if (await runOne(j, size)) {
          j += size;
          done += size;
        } else small = Math.max(minChunk, Math.floor(small / 2));
      }
    }
    // Individual calls that failed INSIDE a successful batch may have simply run out of the batch's gas
    // (heavy view functions like Nado getHealth loop over ~100 products). Retry those in smaller batches.
    const failedIdx: number[] = [];
    for (const [s, n] of starts) for (let k = s; k < s + n; k++) if (out[k] && !out[k]!.ok) failedIdx.push(k);
    const succeededAny = starts.some(([s, n]) => out.slice(s, s + n).some((r) => r?.ok));
    if (failedIdx.length && succeededAny) failedAny = true;
    if (failedIdx.length) await retryFailed(failedIdx);
    chunk = failedAny ? Math.max(minChunk, Math.floor(chunk / 2)) : Math.min(1000, Math.ceil(chunk * 1.25));
    o.onChunk?.(done, calls.length, chunk);
  }
  return out;

  /** re-run failed calls: first in groups of ≤10, then one by one (capped so a systemic failure can't spam the RPC) */
  async function retryFailed(idx: number[]) {
    for (const size of [10, 1]) {
      const pending = idx.filter((k) => !out[k]!.ok);
      if (!pending.length) return;
      if (size === 1 && pending.length > 200) return; // looks systemic, not gas — keep the recorded errors
      for (let p = 0; p < pending.length; p += size) {
        const group = pending.slice(p, p + size);
        try {
          const res = await client.multicall({
            contracts: group.map((k) => calls[k]!) as never,
            allowFailure: true,
            blockNumber: o.blockNumber,
            batchSize: 0,
          } as never);
          (res as Array<{ status: 'success' | 'failure'; result?: unknown; error?: unknown }>).forEach((r, g) => {
            if (r.status === 'success') out[group[g]!] = { ok: true, value: r.result };
            else out[group[g]!] = { ok: false, error: `${errMessage(r.error)} (also failed when retried in a batch of ${size})` };
          });
        } catch (e) {
          for (const k of group) out[k] = { ok: false, error: describeRpcError(e) };
          if (classifyRpcError(e) === 'slow') await sleep(backoffMs(2, o.backoffBaseMs));
        }
      }
    }
  }
}
