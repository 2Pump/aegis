import { createPublicClient, custom, type PublicClient } from 'viem';
import { ink } from 'viem/chains';
import { describe, expect, it } from 'vitest';
import { maskRpc, rotatingTransport, splitRpcList, type RotateStats } from '../src/rotate.js';

/** a fake endpoint: answers eth_blockNumber with its own id, or fails the way a real node would */
function node(id: number, fail?: () => Error | null) {
  const calls = { n: 0 };
  const t = custom({
    async request({ method }) {
      calls.n++;
      const e = fail?.();
      if (e) throw e;
      if (method === 'eth_blockNumber') return `0x${id.toString(16)}`;
      if (method === 'eth_chainId') return '0xdef1';
      throw new Error(`unexpected ${method}`);
    },
  });
  return { t, calls };
}
const rpcError = (details: string, code: number) => Object.assign(new Error('RPC Request failed.'), { shortMessage: 'RPC Request failed.', details, code });
const client = (ts: ReturnType<typeof rotatingTransport>) => createPublicClient({ chain: ink, transport: ts, cacheTime: 0 }) as PublicClient;
const head = async (c: PublicClient) => Number(await c.request({ method: 'eth_blockNumber' }));

describe('rotating RPC', () => {
  it('spreads requests round-robin across endpoints', async () => {
    const a = node(1), b = node(2), c = node(3);
    const cl = client(rotatingTransport([a.t, b.t, c.t]));
    const got = [await head(cl), await head(cl), await head(cl), await head(cl)];
    expect(got).toEqual([1, 2, 3, 1]);
  });

  it('a throttled endpoint is skipped and rested; the request still succeeds', async () => {
    const throttled = node(1, () => rpcError('Your IP has exceeded its request rate limit', -32016));
    const fine = node(2);
    const stats: RotateStats = { ok: [], skipped: [] };
    const cl = client(rotatingTransport([throttled.t, fine.t], { coolMs: 60_000, stats }));
    expect(await head(cl)).toBe(2); // tried 1 (throttled) → 2
    expect(await head(cl)).toBe(2);
    expect(await head(cl)).toBe(2); // 1 is resting: not even tried
    expect(throttled.calls.n).toBe(1);
    expect(stats.skipped[0]).toBe(1);
    expect(stats.ok[1]).toBe(3);
  });

  it('"request too big" is thrown straight back so the scanner shrinks its window (not hidden by failover)', async () => {
    const a = node(1, () => rpcError('block range greater than 1000 max', -32602));
    const b = node(2);
    const cl = client(rotatingTransport([a.t, b.t]));
    await expect(head(cl)).rejects.toThrow();
    expect(b.calls.n).toBe(0);
  });

  it('a node a few blocks behind ("header not found") hands the request to the next one without resting', async () => {
    let lag = true;
    const a = node(1, () => (lag ? rpcError('header not found', -32000) : null));
    const b = node(2);
    const cl = client(rotatingTransport([a.t, b.t], { coolMs: 60_000 }));
    expect(await head(cl)).toBe(2);
    lag = false;
    expect(await head(cl)).toBe(2); // round-robin turn of b
    expect(await head(cl)).toBe(1); // a was not rested
  });

  it('when every endpoint is throttled, the last error comes back (the scanner then waits and retries)', async () => {
    const a = node(1, () => rpcError('rate limit', 429));
    const b = node(2, () => rpcError('Too Many Requests', 429));
    const cl = client(rotatingTransport([a.t, b.t]));
    await expect(head(cl)).rejects.toThrow();
  });

  it('parses comma lists and hides keys in logs', () => {
    expect(splitRpcList(' https://a.x , https://b.y\nhttps://c.z ')).toEqual(['https://a.x', 'https://b.y', 'https://c.z']);
    expect(splitRpcList(undefined)).toEqual([]);
    expect(maskRpc('https://ink-mainnet.example.com/v2/SECRETKEY')).toBe('https://ink-mainnet.example.com/…(key hidden)');
    expect(maskRpc('https://rpc-gel.inkonchain.com')).toBe('https://rpc-gel.inkonchain.com');
  });
});

describe('reading a little behind the tip (the "0x" seen on the first pnpm prove)', () => {
  it('recognizes the empty-data error a lagging load-balanced node produces', async () => {
    const { isZeroData } = await import('../src/chain.js');
    expect(isZeroData('Cannot decode zero data ("0x") with ABI parameters.')).toBe(true);
    expect(isZeroData('The contract function "x" returned no data ("0x").')).toBe(true);
    expect(isZeroData('execution reverted')).toBe(false);
  });
  it('stableHead reads 3 blocks behind the tip, uncached', async () => {
    const { stableHead } = await import('../src/chain.js');
    const a = node(1_000);
    const cl = client(rotatingTransport([a.t]));
    expect(await stableHead(cl)).toBe(997n);
    expect(await stableHead(cl, 20n)).toBe(980n);
  });
});
