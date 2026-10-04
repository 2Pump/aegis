/**
 * Release 3 writer — runs inside the hourly census after the ledger. Read-only on the chain.
 *  - Oracle Watch: one snapshot of every price source → history/oracle/latest.json (+ a price point per run in
 *    history/prices/<month>.json for charts and forecast scoring). A failed read keeps the last good watch
 *    (its age shows), never an empty or zeroed one.
 *  - Protocol Change Monitor: parameters → history/params/latest.json; differences → history/changes/<month>.json.
 *  - Forecast scoring: Pressure forecasts vs recorded prices → history/forecast-score.json.
 */
import type { PublicClient } from 'viem';
import { READER_VERSION, readOracleSnapshot, readProtocolParams, scanLogs } from '@aegis/ink-io';
import { INDEX_PATH, aggPath, isAggFile, isHistoryIndex, monthOf, type AggPoint } from '../history.js';
import { forecastPath, isLedgerFile, ledgerPath, type ForecastFile, type LedgerRecord } from '../ledger.js';
import { ORACLE_LATEST, appendPrices, buildOracleWatch, pricePath, pricePoint, type OracleWatch, type PriceFile } from '../oracle.js';
import { CHANGES, PARAMS_LATEST, appendChanges, changesPath, diffParams, isParamsLatest, summarize, toLatest, type ChangeRecord, type ParamsLatest } from '../changes.js';
import { FORECAST_SCORE_PATH, scoreForecasts } from '../forecast.js';
import type { PressureSnapshot } from '../pressure.js';
import type { CensusStore } from './store.js';

export interface IntelOpts {
  store: CensusStore;
  client: PublicClient;
  head: number;
  pressure?: PressureSnapshot | null;
  log?: (m: string) => void;
  scan?: { paceMs?: number; backoffBaseMs?: number };
  nowMs?: number;
}

const isWatch = (x: unknown): x is OracleWatch => !!x && (x as OracleWatch).kind === 'aegis-oracle-watch' && Array.isArray((x as OracleWatch).rows);
const isPressure = (x: unknown): x is PressureSnapshot => !!x && typeof (x as PressureSnapshot).block === 'number' && typeof (x as PressureSnapshot).hist === 'object';

async function aggAround(store: CensusStore, months: string[]): Promise<AggPoint[]> {
  const files = await Promise.all(months.map((m) => store.get(aggPath(m)).catch(() => null)));
  return files.flatMap((f) => (isAggFile(f) ? f.points : []));
}

export async function recordOracles(o: IntelOpts): Promise<OracleWatch | null> {
  const log = o.log ?? (() => {});
  const snap = await readOracleSnapshot(o.client, BigInt(o.head));
  if (!snap.ok) {
    log(`oracles: not read this run (${snap.error.message.slice(0, 160)}) — the last good reading stays, with its age`);
    return null;
  }
  const prevRaw = await o.store.get(ORACLE_LATEST).catch(() => null);
  const pressure = o.pressure ?? (await o.store.get('pressure.json').then((p) => (isPressure(p) ? p : null)).catch(() => null));
  const watch = buildOracleWatch({ snap: snap.value, prev: isWatch(prevRaw) ? prevRaw : null, pressure, nowMs: o.nowMs });
  await o.store.put(ORACLE_LATEST, watch);
  const m = monthOf(snap.value.at);
  const pf = await o.store.get(pricePath(m)).catch(() => null);
  await o.store.put(pricePath(m), appendPrices(pf, m, pricePoint(snap.value)));
  const fresh = watch.events.filter((e) => e.block === watch.block);
  log(`oracles: ${watch.rows.length} assets · ${Object.entries(watch.summary).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ')}${fresh.length ? ` · ${fresh.length} new event(s): ${fresh.map((e) => `${e.symbol} ${e.status}`).join(', ')}` : ''}${watch.errors.length ? ` · errors: ${watch.errors.join('; ').slice(0, 160)}` : ''}`);
  return watch;
}

export async function recordChanges(o: IntelOpts): Promise<ChangeRecord[]> {
  const log = o.log ?? (() => {});
  const read = await readProtocolParams(o.client, BigInt(o.head));
  if (!read.ok) {
    log(`changes: parameters not read this run (${read.error.message.slice(0, 160)})`);
    return [];
  }
  const blk = await o.client.getBlock({ blockNumber: BigInt(o.head) }).catch(() => null);
  const at = blk ? Number(blk.timestamp) * 1000 : (o.nowMs ?? Date.now());
  const prevRaw = await o.store.get(PARAMS_LATEST).catch(() => null);
  const prev = isParamsLatest(prevRaw) ? prevRaw : null;
  const next = toLatest(read.value, at, READER_VERSION, prev?.since);
  if (!prev) {
    await o.store.put(PARAMS_LATEST, next);
    log(`changes: monitoring ${Object.keys(next.params).length} parameters from now on (${next.unsupported.length} not readable: ${next.unsupported.slice(0, 6).join(', ')}${next.unsupported.length > 6 ? '…' : ''})`);
    return [];
  }
  const diffs = diffParams(prev, next);
  // a value that failed to read this run keeps its last reading (a failed read is not a change)
  for (const [k, v] of Object.entries(prev.params)) if (!next.params[k] && !diffs.some((d) => d.key === k && d.kind === 'removed')) next.params[k] = v;
  const records: ChangeRecord[] = [];
  if (diffs.length) {
    // Tydro: the PoolConfigurator's transactions in that block range are the candidates
    let txCandidates: string[] | null = null;
    let txNote = 'Nado: the transaction is not identified (Nado does not emit a dedicated configuration event AEGIS reads)';
    const cfg = next.params['tydro:protocol:poolConfigurator']?.v;
    if (diffs.some((d) => d.protocol === 'tydro') && cfg && /^0x[0-9a-f]{40}$/.test(cfg)) {
      const r = await scanLogs(o.client, { address: cfg as `0x${string}`, topics: [], fromBlock: prev.block + 1, toBlock: o.head, maxRetries: 3, paceMs: o.scan?.paceMs, backoffBaseMs: o.scan?.backoffBaseMs });
      txCandidates = [...new Set(r.logs.map((l) => String(l.transactionHash).toLowerCase()))].slice(0, 20);
      txNote = r.complete ? `${txCandidates.length} PoolConfigurator transaction(s) between the two readings` : 'PoolConfigurator scan incomplete — candidates may be missing';
    }
    const months = [...new Set([monthOf(prev.at), monthOf(at)])];
    const pts = await aggAround(o.store, months);
    const before = [...pts].filter((p) => p.block <= prev.block).sort((a, b) => a.block - b.block).at(-1) ?? null;
    const after = [...pts].filter((p) => p.block <= o.head).sort((a, b) => a.block - b.block).at(-1) ?? null;
    for (const d of diffs) {
      records.push({
        id: `${d.key}@${o.head}`,
        ...d,
        between: { fromBlock: prev.block, toBlock: o.head, fromAt: prev.at, toAt: at },
        txCandidates: d.protocol === 'tydro' ? txCandidates : null,
        txNote: d.protocol === 'tydro' ? txNote : 'not identified (no configuration event on Nado that AEGIS reads)',
        verification: `read on-chain at block ${prev.block.toLocaleString('en-US')} (old) and ${o.head.toLocaleString('en-US')} (new) with ${d.source}`,
        reader: `${READER_VERSION} · ${CHANGES.VERSION}`,
        impact: {
          before: summarize(before),
          after: summarize(after && after.block > (before?.block ?? -1) ? after : null),
          note:
            before && after && after.block > before.block
              ? "AEGIS's own counts just before and just after — observed, not isolated: price moves in the same hour are in them too."
              : 'No recorded point on one side of the change — no impact shown rather than a reconstructed one.',
        },
      });
    }
    const m = monthOf(at);
    await o.store.put(changesPath(m), appendChanges(await o.store.get(changesPath(m)).catch(() => null), m, records));
    log(`changes: ${records.length} change(s) between blocks ${prev.block} and ${o.head}: ${records.slice(0, 5).map((r) => `${r.subject} ${r.name} ${r.old ?? '—'} → ${r.new ?? '—'}`).join('; ')}${records.length > 5 ? '…' : ''}`);
    // keep the months listed in the index so the site knows where to look
    const idx = await o.store.get(INDEX_PATH).catch(() => null);
    if (isHistoryIndex(idx) && !(idx.changeMonths ?? []).includes(m)) await o.store.put(INDEX_PATH, { ...idx, changeMonths: [...(idx.changeMonths ?? []), m].sort() });
  }
  await o.store.put(PARAMS_LATEST, next as ParamsLatest);
  return records;
}

export async function rescoreForecasts(store: CensusStore, nowMs: number, log: (m: string) => void = () => {}): Promise<void> {
  const idx = await store.get(INDEX_PATH).catch(() => null);
  if (!isHistoryIndex(idx)) return;
  const months = idx.months.slice(-2);
  const [ff, pf, liqs] = await Promise.all([
    Promise.all(months.map((m) => store.get(forecastPath(m)).catch(() => null))),
    Promise.all(months.map((m) => store.get(pricePath(m)).catch(() => null))),
    Promise.all((idx.ledgerMonths ?? []).filter((m) => months.includes(m)).map((m) => store.get(ledgerPath(m)).catch(() => null))),
  ]);
  const forecasts = ff.flatMap((f) => ((f as ForecastFile)?.kind === 'aegis-forecasts' ? (f as ForecastFile).records : []));
  const prices = pf.flatMap((f) => ((f as PriceFile)?.kind === 'aegis-prices' ? (f as PriceFile).points : []));
  const agg = await aggAround(store, months);
  const liquidations: LedgerRecord[] = liqs.filter(isLedgerFile).flatMap((f) => f.records);
  const s = scoreForecasts({ forecasts, prices, agg, liquidations, nowMs });
  await store.put(FORECAST_SCORE_PATH, s);
  log(`forecasts: ${s.forecasts} recorded · ${s.scenarios.reduce((a, x) => a + x.judged, 0)} scenario checks judged · ${s.scenarios.reduce((a, x) => a + x.reached, 0)} reached · ${s.unjudgeable} before prices were recorded · ${s.pending} pending`);
}
