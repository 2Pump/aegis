import { describe, expect, it } from 'vitest';
import { beforeSend, scrubUrl } from './analytics';

describe('analytics page addresses', () => {
  it('never sends a wallet address, a query or a hash', () => {
    expect(scrubUrl('https://phrourax.com/hull/0x5A7E077320A97d0c6bEfC88defC92E7F1dbB2757')).toBe('https://phrourax.com/hull/[address]');
    expect(scrubUrl('https://phrourax.com/auth/verify#t=secret')).toBe('https://phrourax.com/auth/verify');
    expect(scrubUrl('https://phrourax.com/?rules=1&w=0xabc')).toBe('https://phrourax.com/');
    expect(beforeSend({ type: 'pageview', url: 'https://phrourax.com/hull/0x8d7d64d6cf1d4f018dd101482ac71ad49e30c560?x=1' }).url).toBe('https://phrourax.com/hull/[address]');
    expect(scrubUrl('https://phrourax.com/pricing')).toBe('https://phrourax.com/pricing');
  });
});
