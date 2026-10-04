import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileStore, runCensus, runVerification } from '../src/node/index.js';
import { checkDisplay, latestChecks, type VerificationRecord } from '../src/index.js';
import { fakeChain } from './fakeChain.js';

const HEAD = 57_200_000;

describe('automatic verification (safe fake chain; nothing real is touched)', () => {
  it('cross-checks Nado per subaccount on-chain, records the blocked official API as SOURCE UNAVAILABLE, and never deletes history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-verify-'));
    const store = fileStore(dir);
    const chain = fakeChain({ head: HEAD });
    await runCensus({ scanPaceMs: 0, explorer: false, client: chain.client, store });
    const blocked = async () => ({ status: 403, ok: false, headers: { get: () => 'text/html' }, json: async () => ({}) });
    const logs: string[] = [];
    const recs = await runVerification({ client: chain.client, store, fetch: blocked, log: (m) => logs.push(m), now: () => Date.parse('2026-10-04T06:00:00Z') });

    const nadoChain = recs.find((r) => r.venue === 'nado' && r.sourceType === 'on-chain')!;
    expect(nadoChain.status).toBe('PASS');
    expect(nadoChain.fields.some((f) => f.label.includes('default subaccount') && f.pass === true)).toBe(true);
    expect(nadoChain.rulesVersion).toMatch(/^v\d/);
    expect(nadoChain.engineVersion).toMatch(/^pressure-/);

    const api = recs.find((r) => r.sourceType === 'official-api')!;
    expect(api.status).toBe('SOURCE_UNAVAILABLE');
    expect(api.failureReason).toMatch(/does not get around that/);
    expect(checkDisplay(api, Date.now())).toBe('SOURCE UNAVAILABLE');

    // the fake chain has no AaveProtocolDataProvider: the Tydro check's source is unreachable → never a pass
    const tydro = recs.find((r) => r.venue === 'tydro');
    if (tydro) expect(tydro.status).not.toBe('PASS');
    expect(logs.some((l) => l.includes('Nado isolated subaccount · no suitable wallet'))).toBe(true);

    // a second run appends; the first run's records are still there
    await runVerification({ client: chain.client, store, fetch: blocked, now: () => Date.parse('2026-10-05T06:00:00Z') });
    const log = (await store.get('verification-log.json')) as VerificationRecord[];
    expect(log.length).toBe(recs.length * 2);
    // addresses are stored short, never in full
    expect(JSON.stringify(log)).not.toMatch(/0x[0-9a-f]{40}/i);
    const groups = latestChecks(log, Date.parse('2026-10-05T07:00:00Z'));
    expect(groups.find((g) => g.sourceType === 'on-chain' && g.venue === 'nado')?.display).toBe('CURRENT');
  });
});
