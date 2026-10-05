/**
 * PROTOCOL CHANGE MONITOR (pure) — `changes-1.0.0`. Release 3.
 *
 * Every run reads the risk-relevant parameters both protocols expose on-chain (ink-io oracles.ts →
 * readProtocolParams) and compares them with the previous run's. A difference is a change record:
 * old → new, the two blocks it happened between, the contract and function it was read from, and — for Tydro —
 * the PoolConfigurator transactions in that block range as candidates. Only parameters that actually read are
 * monitored; the rest are listed as unsupported, never claimed.
 *
 * Impact is shown as BEFORE / AFTER from the Flight Recorder's own counts on either side of the change. That is
 * observational (anything else that hour — prices — is in it too) and is labelled so. A change detected without
 * a recorded point on one side shows no impact rather than a reconstructed one.
 */
import type { ParamRead, ParamSnapshot } from '@aegis/ink-io';
import type { AggPoint } from './history.js';

export const CHANGES = { VERSION: 'changes-1.0.0' } as const;
export const PARAMS_LATEST = 'history/params/latest.json' as const;
export const changesPath = (month: string) => `history/changes/${month}.json` as const;

export interface ParamsLatest {
  v: 1;
  kind: 'aegis-params';
  block: number;
  at: number;
  /** first run this was recorded (monitoring since) */
  since: string;
  params: Record<string, { v: string; protocol: 'tydro' | 'nado'; subject: string; name: string; source: string }>;
  unsupported: string[];
  reader: string;
}

export interface AggSummary {
  block: number;
  at: string;
  near: number;
  watch: number;
  nearMaterial: number;
  stress: string | null;
}

export interface ChangeRecord {
  id: string;
  protocol: 'tydro' | 'nado';
  subject: string;
  name: string;
  key: string;
  kind: 'changed' | 'added' | 'removed';
  old: string | null;
  new: string | null;
  between: { fromBlock: number; toBlock: number; fromAt: number; toAt: number };
  /** Tydro: transactions to the PoolConfigurator in that block range (one of them made the change) */
  txCandidates: string[] | null;
  txNote: string;
  source: string;
  verification: string;
  reader: string;
  impact: { before: AggSummary | null; after: AggSummary | null; note: string };
}

export interface ChangesFile {
  v: 1;
  kind: 'aegis-changes';
  month: string;
  records: ChangeRecord[];
}

export function toLatest(snap: ParamSnapshot, at: number, reader: string, since?: string): ParamsLatest {
  const params: ParamsLatest['params'] = {};
  for (const p of snap.params) params[p.key] = { v: p.value, protocol: p.protocol, subject: p.subject, name: p.name, source: p.source };
  return { v: 1, kind: 'aegis-params', block: snap.block, at, since: since ?? new Date(at).toISOString(), params, unsupported: snap.unsupported, reader };
}

export function isParamsLatest(x: unknown): x is ParamsLatest {
  const f = x as ParamsLatest;
  return !!f && f.v === 1 && f.kind === 'aegis-params' && typeof f.params === 'object' && f.params !== null;
}

/**
 * Differences between two readings. Parameters that became unreadable are NOT reported as removed (a failed read
 * isn't a change) — only a product that left Nado's product list is.
 */
export function diffParams(prev: ParamsLatest, next: ParamsLatest): Array<Pick<ChangeRecord, 'key' | 'protocol' | 'subject' | 'name' | 'kind' | 'old' | 'new' | 'source'>> {
  const out: Array<Pick<ChangeRecord, 'key' | 'protocol' | 'subject' | 'name' | 'kind' | 'old' | 'new' | 'source'>> = [];
  const nowUnsupported = new Set(next.unsupported.map((u) => u.split(' ')[0]!));
  for (const [k, n] of Object.entries(next.params)) {
    const p = prev.params[k];
    if (!p) out.push({ key: k, protocol: n.protocol, subject: n.subject, name: n.name, kind: 'added', old: null, new: n.v, source: n.source });
    else if (p.v !== n.v) out.push({ key: k, protocol: n.protocol, subject: n.subject, name: n.name, kind: 'changed', old: p.v, new: n.v, source: n.source });
  }
  for (const [k, p] of Object.entries(prev.params)) {
    if (next.params[k]) continue;
    // a whole Nado product gone from the list = removed; any other missing value = a failed read this run (skip)
    const productGone = p.protocol === 'nado' && p.name === 'listed' && !nowUnsupported.has('nado:products');
    if (productGone) out.push({ key: k, protocol: p.protocol, subject: p.subject, name: p.name, kind: 'removed', old: p.v, new: null, source: p.source });
  }
  return out;
}

export const summarize = (p: AggPoint | null | undefined): AggSummary | null =>
  p ? { block: p.block, at: p.at, near: p.risk['0'][2], watch: p.risk['0'][1], nearMaterial: p.risk['1k'][2], stress: p.stress?.level ?? null } : null;

export function appendChanges(file: unknown, month: string, recs: readonly ChangeRecord[]): ChangesFile {
  const f = file as ChangesFile;
  const base: ChangesFile = f && f.v === 1 && f.kind === 'aegis-changes' && f.month === month && Array.isArray(f.records) ? { ...f, records: [...f.records] } : { v: 1, kind: 'aegis-changes', month, records: [] };
  const seen = new Set(base.records.map((r) => r.id));
  for (const r of recs) if (!seen.has(r.id)) (seen.add(r.id), base.records.push(r));
  base.records.sort((a, b) => a.between.toBlock - b.between.toBlock || a.key.localeCompare(b.key));
  return base;
}

/** Human labels for parameter names (units included where Phrourax knows them). */
export const PARAM_LABEL: Record<string, string> = {
  ltv: 'Loan-to-value (bps)',
  liquidationThreshold: 'Liquidation threshold (bps)',
  liquidationBonus: 'Liquidation bonus (bps, 10000 = none)',
  reserveFactor: 'Reserve factor (bps)',
  usageAsCollateralEnabled: 'Usable as collateral',
  borrowingEnabled: 'Borrowing enabled',
  isActive: 'Active',
  isFrozen: 'Frozen',
  isPaused: 'Paused',
  borrowCap: 'Borrow cap (whole tokens, 0 = none)',
  supplyCap: 'Supply cap (whole tokens, 0 = none)',
  debtCeiling: 'Debt ceiling',
  liquidationProtocolFee: 'Liquidation protocol fee (bps)',
  interestRateStrategy: 'Interest-rate strategy contract',
  oracleSource: 'Oracle source contract',
  pool: 'Pool contract',
  poolConfigurator: 'PoolConfigurator contract',
  priceOracle: 'Price oracle contract',
  aCLManager: 'ACL manager contract',
  aCLAdmin: 'ACL admin',
  listed: 'Listed product',
  token: 'Token contract',
  longWeightInitial: 'Long weight, initial',
  shortWeightInitial: 'Short weight, initial',
  longWeightMaintenance: 'Long weight, maintenance',
  shortWeightMaintenance: 'Short weight, maintenance',
};

export const paramLabel = (name: string) => PARAM_LABEL[name] ?? (name.endsWith('.implementation') ? `${name.replace('.implementation', '')} implementation (upgrade)` : name);

export type { ParamRead };
