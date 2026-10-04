import { describe, expect, it } from 'vitest';
import { appendRecords, checkDisplay, compareField, finalize, latestChecks, type VerificationRecord } from '../src/index.js';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const field = (expected: number | null, aegis: number | null, tolerance = 0.001) => compareField({ id: 'x', label: 'x', expected, aegis, tolerance, unit: 'rel' });
const rec = (over: Partial<VerificationRecord> & { fields?: VerificationRecord['fields'] }): VerificationRecord =>
  finalize({
    v: 1,
    kind: 'auto',
    venue: 'tydro',
    wallet: '0x1234…abcd',
    case: 'Tydro borrower',
    source: 'AaveProtocolDataProvider',
    sourceType: 'on-chain',
    at: '2026-10-04T10:00:00Z',
    block: 57_600_000,
    rulesVersion: 'v1.2.0',
    engineVersion: 'pressure-1.0.0',
    fields: [field(100, 100)],
    sourceUnavailable: false,
    ...over,
  });

describe('verification records', () => {
  it('a current successful check is CURRENT', () => expect(checkDisplay(rec({}), NOW)).toBe('CURRENT'));
  it('a successful check older than 24 h is STALE', () => expect(checkDisplay(rec({ at: '2026-10-02T10:00:00Z' }), NOW)).toBe('STALE'));
  it('a field outside tolerance fails the record and names the field', () => {
    const r = rec({ fields: [compareField({ id: 'hf', label: 'Tydro HF', expected: 1.5, aegis: 1.6, tolerance: 0.005, unit: 'rel' })] });
    expect(r.status).toBe('FAIL');
    expect(r.failureReason).toMatch(/Tydro HF/);
    expect(checkDisplay(r, NOW)).toBe('FAILED');
  });
  it('a stated failure stays FAIL even when every compared field matched', () => {
    expect(rec({ failureReason: 'a machine check for this venue failed' }).status).toBe('FAIL');
  });
  it('an unreachable source is SOURCE UNAVAILABLE — never a pass, even with nothing failing', () => {
    const r = rec({ sourceUnavailable: true, fields: [], failureReason: 'HTTP 403 (Cloudflare challenge)' });
    expect(r.status).toBe('SOURCE_UNAVAILABLE');
    expect(checkDisplay(r, NOW)).toBe('SOURCE UNAVAILABLE');
  });
  it('nothing compared (values missing) is a FAIL, not a pass', () => {
    const r = rec({ fields: [field(null, 3)] });
    expect(r.status).toBe('FAIL');
    expect(r.fields[0]!.pass).toBeNull();
  });
  it('the last success stays visible when a newer attempt fails', () => {
    const ok = rec({ at: '2026-10-04T06:00:00Z' });
    const bad = rec({ at: '2026-10-04T11:00:00Z', fields: [field(1, 2)] });
    const [g] = latestChecks([ok, bad], NOW);
    expect(g!.display).toBe('FAILED');
    expect(g!.lastSuccess?.at).toBe(ok.at);
    expect(g!.lastSuccessDisplay).toBe('CURRENT');
  });
  it('a record under old rules keeps its version — never relabelled', () => {
    const old = rec({ rulesVersion: 'v1.1.0', at: '2026-09-29T01:43:02Z' });
    const [g] = latestChecks([old], NOW);
    expect(g!.latest.rulesVersion).toBe('v1.1.0');
    expect(g!.display).toBe('STALE');
  });
  it('history is appended, never deleted; junk in the log is refused', () => {
    const a = rec({ at: '2026-10-03T10:00:00Z' });
    const b = rec({});
    expect(appendRecords([a, { nope: 1 }, 'x'], [b])).toEqual([a, b]);
    expect(appendRecords(null, [b])).toEqual([b]);
  });
});
