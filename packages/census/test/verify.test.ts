import { describe, expect, it } from 'vitest';
import { EXPECTED_CHECKS, appendRecords, checkDisplay, compareField, finalize, latestChecks, notChecked, verifyDue, type VerificationRecord } from '../src/index.js';

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
  it('a successful check older than 6 h is STALE; 2 h old is CURRENT', () => {
    expect(checkDisplay(rec({ at: '2026-10-04T05:00:00Z' }), NOW)).toBe('STALE');
    expect(checkDisplay(rec({ at: '2026-10-04T10:00:00Z' }), NOW)).toBe('CURRENT');
  });
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
    expect(g!.latest!.rulesVersion).toBe('v1.1.0');
    expect(g!.display).toBe('STALE');
  });
  it('history is appended, never deleted; junk in the log is refused', () => {
    const a = rec({ at: '2026-10-03T10:00:00Z' });
    const b = rec({});
    expect(appendRecords([a, { nope: 1 }, 'x'], [b])).toEqual([a, b]);
    expect(appendRecords(null, [b])).toEqual([b]);
  });

  it('every expected check gets a row: one never run shows NOT CHECKED, never left out', () => {
    const g = latestChecks([], NOW);
    expect(g).toHaveLength(EXPECTED_CHECKS.length);
    expect(g.every((x) => x.display === 'NOT CHECKED' && x.latest === null)).toBe(true);
    expect(g[0]!.case).toBe('Tydro borrower'); // Tydro first
  });
  it('a run that found no wallet is NOT CHECKED — never a pass — and the last success stays visible', () => {
    const ok = rec({});
    const nc = notChecked({ v: 1, kind: 'auto', venue: 'tydro', wallet: '—', case: 'Tydro borrower', source: '—', sourceType: 'on-chain', at: '2026-10-04T11:00:00Z', rulesVersion: 'v1.2.0', engineVersion: null, failureReason: 'no suitable wallet found in 40 tries this run' });
    const t = latestChecks([ok, nc], NOW).find((x) => x.venue === 'tydro')!;
    expect(t.display).toBe('NOT CHECKED');
    expect(t.lastSuccess).toBe(ok);
  });
  it('old "(1 isolated)" names land on the same row as the plain case name', () => {
    const a = rec({ venue: 'nado', case: 'Nado isolated subaccount (1 isolated)', at: '2026-10-04T09:00:00Z' });
    const b = rec({ venue: 'nado', case: 'Nado isolated subaccount', at: '2026-10-04T10:00:00Z' });
    const rows = latestChecks([a, b], NOW).filter((x) => x.venue === 'nado' && x.sourceType === 'on-chain' && x.case.startsWith('Nado isolated'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.latest).toBe(b);
  });

  it('due logic for the hourly census: due with no record, not due inside the window, due after it; manual records don\'t count', () => {
    expect(verifyDue(null, NOW, 3.75).due).toBe(true);
    expect(verifyDue([rec({ at: '2026-10-04T10:00:00Z' })], NOW, 3.75).due).toBe(false); // 2 h old
    expect(verifyDue([rec({ at: '2026-10-04T08:00:00Z' })], NOW, 3.75).due).toBe(true); // 4 h old
    expect(verifyDue([rec({ kind: 'manual', at: '2026-10-04T11:00:00Z' })], NOW, 3.75).due).toBe(true);
    expect(verifyDue('junk', NOW, 3.75).due).toBe(true);
  });
});
