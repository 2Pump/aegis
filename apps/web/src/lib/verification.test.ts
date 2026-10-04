import { describe, expect, it } from 'vitest';
import { PROOF_STALE_DAYS, proofStatus, type Proof } from './verification';

const proof = (at: string, rulesVersion: string): Proof => ({ address: '0xabc', at, block: 1, fields: 12, rulesVersion });

describe('Checks: a stored check is shown honestly', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  it('keeps the rules version it ran under and flags it as older than the current rules', () => {
    const s = proofStatus(proof('2026-09-29T01:43:02Z', 'v1.1.0'), 'v1.2.0', now);
    expect(s.ranUnder).toBe('v1.1.0');
    expect(s.olderRules).toBe(true);
  });
  it('a check under the current rules is not flagged', () => {
    expect(proofStatus(proof('2026-10-02T00:00:00Z', 'v1.2.0'), 'v1.2.0', now).olderRules).toBe(false);
  });
  it(`is STALE after ${PROOF_STALE_DAYS} days, and when its date can't be read`, () => {
    expect(proofStatus(proof('2026-09-29T00:00:00Z', 'v1.2.0'), 'v1.2.0', now).stale).toBe(false);
    expect(proofStatus(proof('2026-08-01T00:00:00Z', 'v1.2.0'), 'v1.2.0', now).stale).toBe(true);
    expect(proofStatus(proof('not a date', 'v1.2.0'), 'v1.2.0', now).stale).toBe(true);
  });
});
