import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetLearnedMaxSpan } from '@aegis/ink-io';
beforeEach(() => resetLearnedMaxSpan());
import { LiveEngine, decodeSnapshot } from '../src/index.js';
import { fileStore, runCensus } from '../src/node/index.js';
import { U, fakeChain } from './fakeChain.js';

const HEAD = 57_200_000;

describe('live layer', () => {
  it('catches a new trade and a price-driven wound within one tick, from real (fake-chain) reads', async () => {
    const snap = await runCensus({ scanPaceMs: 0, explorer: false, client: fakeChain({ head: HEAD }).client, store: fileStore(mkdtempSync(join(tmpdir(), 'aegis-live-'))) });
    const { ships } = decodeSnapshot(snap);

    // 10 blocks later: CARRY wallet traded at HEAD+5; borrower's HF fell to 1.10 (price move, no transaction)
    const later = fakeChain({ head: HEAD + 10, tradeAt: HEAD + 5, borrowerHf100: 110n });
    const engine = new LiveEngine(later.client, { watchEvery: 1, watchBatch: 8 });
    engine.load(ships, snap.block);
    await engine.tick();

    expect(engine.stats.errors).toBe(0);
    expect(engine.stats.cursor).toBe(HEAD + 10);
    expect(engine.stats.touched).toBeGreaterThanOrEqual(1); // the trade
    expect(later.stats.subaccountInfoCalls).toBe(1); // the traded CARRY wallet was re-read exactly
    const borrower = engine.ships.get(U.borrower)!;
    expect(borrower.tags).toContain('WOUNDED');
    expect(borrower.hullTemp).toBe('CRITICAL');
    expect(borrower.woundedSince).toBe(HEAD + 10);
    expect(engine.changes.find((c) => c.address === U.borrower)?.kind).toBe('wounded');
    // unchanged wallets produce no change records
    expect(engine.changes.find((c) => c.address === U.carry)).toBeUndefined();
  });

  it('skips ahead (and says so) when the snapshot is far behind', async () => {
    const far = fakeChain({ head: HEAD + 1_000_000 });
    const engine = new LiveEngine(far.client, { maxCatchUp: 5000 });
    engine.load([], HEAD);
    await engine.tick();
    expect(engine.stats.gap).toBe(true);
    expect(engine.stats.cursor).toBeGreaterThanOrEqual(HEAD + 1_000_000 - 5000);
  });
});
