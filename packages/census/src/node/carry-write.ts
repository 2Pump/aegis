/**
 * Release 4 writer — Yield and Carry. Runs inside the hourly census after Oracle Watch. Read-only on the chain.
 *  - history/carry/days.json   one reading per UTC day (first block of the day), the last 31 days. Each day is read
 *                              once and kept (a past block never changes); missing days are filled from the chain,
 *                              a bounded number per run — so it is idempotent, resumable and safe to rerun.
 *  - history/carry/latest.json the analysis at the latest block (carry.ts buildCarry).
 * A failed read keeps the last good analysis (its age shows), never an empty or zeroed one.
 */
import type { PublicClient } from 'viem';
import { blockAtTime, readCarryPoint, readGas } from '@aegis/ink-io';
import { CARRY, CARRY_DAYS, CARRY_LATEST, buildCarry, isCarryDays, pruneDays, wantedDays, type CarryDays, type CarryFile } from '../carry.js';
import { changesPath, type ChangeRecord, type ChangesFile } from '../changes.js';
import { INDEX_PATH, isHistoryIndex } from '../history.js';
import { ORACLE_LATEST, type OracleWatch } from '../oracle.js';
import type { PressureSnapshot } from '../pressure.js';
import type { CensusStore } from './store.js';

export interface CarryOpts {
  store: CensusStore;
  client: PublicClient;
  head: number;
  pressure?: PressureSnapshot | null;
  log?: (m: string) => void;
  nowMs?: number;
  /** days filled per run at most (default: all wanted) */
  maxNewDays?: number;
}

const isWatch = (x: unknown): x is OracleWatch => !!x && (x as OracleWatch).kind === 'aegis-oracle-watch' && Array.isArray((x as OracleWatch).rows);
const isPressure = (x: unknown): x is PressureSnapshot => !!x && typeof (x as PressureSnapshot).block === 'number' && typeof (x as PressureSnapshot).hist === 'object';

export async function recordCarry(o: CarryOpts): Promise<CarryFile | null> {
  const log = o.log ?? (() => {});
  const t0 = Date.now();
  const headRead = await readCarryPoint(o.client, BigInt(o.head));
  if (!headRead.ok) {
    log(`carry: not read this run (${headRead.error.message.slice(0, 160)}) — the last analysis stays, with its age`);
    return null;
  }
  const head = headRead.value;

  // daily checkpoints: read the missing ones (bounded), keep the rest
  const prevDays = await o.store.get(CARRY_DAYS).catch(() => null);
  let days: CarryDays = isCarryDays(prevDays) ? prevDays : { v: 1, kind: 'aegis-carry-days', points: {} };
  const wanted = wantedDays(head.at);
  const missing = wanted.filter((d) => !days.points[d] && Date.parse(`${d}T00:00:00Z`) < head.at);
  const budget = o.maxNewDays ?? CARRY.DAYS + 1;
  let filled = 0;
  let failed = 0;
  let failStreak = 0;
  const why: string[] = [];
  // newest first: a short history is still useful (24 h, 7 d) if the RPC can't serve older blocks
  for (const d of [...missing].reverse().slice(0, budget)) {
    if (failStreak >= 3) break;
    const b = await blockAtTime(o.client, Date.parse(`${d}T00:00:00Z`), { block: head.block, at: head.at });
    const p = b.ok ? await readCarryPoint(o.client, BigInt(b.value.block)) : null;
    if (p && p.ok && p.value.nado) {
      days = { ...days, points: { ...days.points, [d]: p.value } };
      filled++;
      failStreak = 0;
    } else {
      failed++;
      failStreak++;
      why.push(`${d}: ${!b.ok ? b.error.message : p && !p.ok ? p.error.message : 'Nado markets unreadable at that block'}`.slice(0, 140));
    }
  }
  days = pruneDays(days, wanted);
  if (filled || !isCarryDays(prevDays)) await o.store.put(CARRY_DAYS, days);

  // context: oracle watch, recent parameter changes, the Pressure Map
  const watchRaw = await o.store.get(ORACLE_LATEST).catch(() => null);
  const idx = await o.store.get(INDEX_PATH).catch(() => null);
  const months = isHistoryIndex(idx) ? (idx.changeMonths ?? []).slice(-2) : [];
  const since = head.at - 30 * 86_400_000;
  const changes: ChangeRecord[] = (await Promise.all(months.map((m) => o.store.get(changesPath(m)).catch(() => null))))
    .flatMap((f) => ((f as ChangesFile)?.kind === 'aegis-changes' ? (f as ChangesFile).records : []))
    .filter((r) => r.between.toAt >= since);
  const pressure = o.pressure ?? (await o.store.get('pressure.json').then((p) => (isPressure(p) ? p : null)).catch(() => null));
  const gas = await readGas(o.client, BigInt(o.head)).catch(() => null);
  const census = (await o.store.get('census.json').catch(() => null)) as { coverage?: { share?: Record<string, number | null> } } | null;
  const share = census?.coverage?.share;
  const oiCoverage = typeof share?.nadoOpenInterestLongs === 'number' && typeof share?.nadoOpenInterestShorts === 'number' ? Math.min(share.nadoOpenInterestLongs, share.nadoOpenInterestShorts) : null;

  const file = buildCarry({ head, days: Object.values(days.points), pressure, oracle: isWatch(watchRaw) ? watchRaw : null, changes, gas, oiCoverage, nowMs: o.nowMs ?? Date.now() });
  await o.store.put(CARRY_LATEST, file);

  const have = Object.keys(days.points).length;
  const ok = file.structures.filter((s) => s.net !== null);
  log(
    `carry: ${file.structures.length} structures (${ok.length} with a rate) · ${file.markets.funding.length} perps · daily history ${file.history.days} day(s) from ${have} checkpoint(s)${filled ? ` · ${filled} day(s) read this run` : ''}${failed ? ` · ${failed} day(s) not readable${why.length ? ` (${why.slice(0, 2).join('; ')})` : ''}` : ''} · ${Math.round((Date.now() - t0) / 1000)}s`,
  );
  log(`carry: risk states — ${(['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'] as const).map((r) => `${r} ${file.structures.filter((s) => s.risk === r).length}`).join(' · ')} · gas per transaction ${file.gas.perTxUsd !== null ? `≈ $${file.gas.perTxUsd.toFixed(4)}` : 'not read'}${file.errors.length ? ` · errors: ${file.errors.join('; ').slice(0, 160)}` : ''}`);
  return file;
}
