import { describe, expect, it } from 'vitest';
import { classifyRpcError } from '../src/rpc-errors.js';

// viem wraps JSON-RPC errors as "RPC Request failed." with the node's reason in `details`
const rpcErr = (details: string, status?: number) => Object.assign(new Error('RPC Request failed.'), { shortMessage: 'RPC Request failed.', details, status });

describe('RPC error classification', () => {
  it('reads the node reason under viem\'s generic "RPC Request failed."', () => {
    expect(classifyRpcError(rpcErr('query exceeds max block range 10000'))).toBe('size');
    expect(classifyRpcError(rpcErr('Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range'))).toBe('size');
    expect(classifyRpcError(rpcErr('query returned more than 10000 results'))).toBe('size');
    expect(classifyRpcError(rpcErr('execution reverted: out of gas'))).toBe('size');
  });
  it('rate limits are "slow" even when they say "exceeded"', () => {
    expect(classifyRpcError(rpcErr('rate limit exceeded'))).toBe('slow');
    expect(classifyRpcError(rpcErr('Too Many Requests', 429))).toBe('slow');
    expect(classifyRpcError(rpcErr('Your app has exceeded its compute units per second capacity'))).toBe('slow');
  });
  it('bare failures and 5xx are "slow"', () => {
    expect(classifyRpcError(Object.assign(new Error('HTTP request failed.'), { shortMessage: 'HTTP request failed.', status: 503 }))).toBe('slow');
    expect(classifyRpcError(rpcErr(''))).toBe('slow');
    expect(classifyRpcError(new Error('fetch failed'))).toBe('slow');
  });
});
