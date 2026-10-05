/**
 * INK EVENTS (pure) — `events-1.0.0`. Release 5.
 *
 * One canonical, balance-free feed of Ink-wide events, built from what the census already records. Telegram alerts
 * (/protocol) and webhooks both read it, so the same thing is never described two ways:
 *   oracle.*                    Oracle Watch transitions (already deduplicated with cooldown + hysteresis there)
 *   protocol.parameter_changed  Protocol Change Monitor records
 *   stress.level_changed        Ink Stress Level moving between two full scans
 *   cascade.detected            a new liquidation cascade (cascade-1.0.0 grouping)
 *   verification.failed         an automatic check that FAILED (not "not checked", not "source unavailable")
 * Wallet events (risk / classification / stale / partial) come from the alerts transition engine (alerts/engine.ts);
 * `wallet.liquidated` comes from the ledger, for wallets someone watches. Every id is stable, so a consumer can
 * deduplicate by id; nothing here carries a balance, a health factor or a price at which anyone is liquidated.
 */
import type { ChangeRecord } from './changes.js';
import type { AggPoint } from './history.js';
import { cascades, type LedgerRecord } from './ledger.js';
import type { OracleWatch } from './oracle.js';
import type { VerificationRecord } from './verify.js';

export const EVENTS_VERSION = 'events-1.0.0' as const;

export const INK_EVENT_TYPES = [
  'oracle.divergence',
  'oracle.depeg',
  'oracle.stale',
  'oracle.jump',
  'oracle.invalid',
  'oracle.resolved',
  'protocol.parameter_changed',
  'stress.level_changed',
  'cascade.detected',
  'verification.failed',
] as const;
export const WALLET_EVENT_TYPES = ['wallet.risk_changed', 'wallet.classification_changed', 'wallet.data_stale', 'wallet.report_partial', 'wallet.unreadable', 'wallet.liquidated'] as const;
export type InkEventType = (typeof INK_EVENT_TYPES)[number];
export type WalletEventType = (typeof WALLET_EVENT_TYPES)[number];
export type EventType = InkEventType | WalletEventType;

/** Only these value types — the schema itself keeps balances out (no nested objects to hide one in). */
export type EventData = Record<string, string | number | boolean | null>;

export interface InkEvent {
  id: string;
  type: EventType;
  /** unix ms when it happened (or was first observed) */
  at: number;
  block: number | null;
  /** asset / parameter key / 'ink' / shortened wallet */
  subject: string;
  text: string;
  data: EventData;
  urgent: boolean;
  version: typeof EVENTS_VERSION;
}

const ev = (e: Omit<InkEvent, 'version'>): InkEvent => ({ ...e, version: EVENTS_VERSION });
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function oracleEvents(w: OracleWatch | null): InkEvent[] {
  if (!w) return [];
  const map: Record<string, InkEventType> = { DIVERGENT: 'oracle.divergence', DEPEG: 'oracle.depeg', STALE: 'oracle.stale', JUMP: 'oracle.jump', INVALID: 'oracle.invalid', RESOLVED: 'oracle.resolved' };
  return w.events
    .filter((e) => map[e.status])
    .map((e) =>
      ev({ id: `oracle|${e.id}`, type: map[e.status]!, at: e.at, block: e.block, subject: e.symbol, text: e.text, data: { asset: e.asset, symbol: e.symbol, check: e.kind, status: e.status }, urgent: e.status === 'DEPEG' || e.status === 'INVALID' }),
    );
}

export function changeEvents(recs: readonly ChangeRecord[]): InkEvent[] {
  return recs.map((r) =>
    ev({
      id: `change|${r.id}`,
      type: 'protocol.parameter_changed',
      at: r.between.toAt,
      block: r.between.toBlock,
      subject: r.key,
      text: `${r.protocol === 'tydro' ? 'Tydro' : 'Nado'} ${r.subject}: ${r.name} ${r.old ?? '—'} → ${r.new ?? '—'} (between blocks ${r.between.fromBlock} and ${r.between.toBlock})`,
      data: { protocol: r.protocol, subject: r.subject, parameter: r.name, kind: r.kind, old: r.old, new: r.new, fromBlock: r.between.fromBlock, toBlock: r.between.toBlock },
      urgent: /liquidationThreshold|isFrozen|isPaused|implementation|oracleSource|Weight/.test(r.name),
    }),
  );
}

/** A change of level between two consecutive points that both measured it (full scans). */
export function stressEvents(points: readonly AggPoint[]): InkEvent[] {
  const pts = [...points].filter((p) => p.stress).sort((a, b) => a.block - b.block);
  const out: InkEvent[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!.stress!;
    const b = pts[i]!.stress!;
    if (a.level === b.level) continue;
    const p = pts[i]!;
    out.push(
      ev({
        id: `stress|${p.block}`,
        type: 'stress.level_changed',
        at: Date.parse(p.at),
        block: p.block,
        subject: 'ink',
        text: `Ink Stress Level ${a.level} → ${b.level}${b.confidence === 'REDUCED' ? ' (reduced confidence)' : ''}`,
        data: { from: a.level, to: b.level, confidence: b.confidence, version: b.version },
        urgent: b.level === 'CRITICAL',
      }),
    );
  }
  return out;
}

export function cascadeEvents(liq: readonly LedgerRecord[]): InkEvent[] {
  return cascades(liq).map((c) =>
    ev({
      id: `cascade|${c.id}`,
      type: 'cascade.detected',
      at: c.end,
      block: null,
      subject: 'ink',
      text: `Liquidation cascade: ${c.size} liquidations between ${new Date(c.start).toISOString().slice(0, 16)}Z and ${new Date(c.end).toISOString().slice(11, 16)}Z${c.centredOn ? `, mostly ${c.centredOn.family}` : ''}`,
      data: { cascade: c.id, size: c.size, start: c.start, end: c.end, centredOn: c.centredOn?.family ?? null, uncertain: c.uncertain, version: c.version },
      urgent: c.size >= 10,
    }),
  );
}

export function verificationEvents(recs: readonly VerificationRecord[]): InkEvent[] {
  return recs
    .filter((r) => r.status === 'FAIL')
    .map((r) =>
      ev({
        id: `verify|${r.venue}|${r.sourceType}|${r.case}|${r.at}`,
        type: 'verification.failed',
        at: Date.parse(r.at),
        block: r.block,
        subject: `${r.venue}:${r.case}`,
        text: `Automatic check FAILED — ${r.venue} ${r.case} (${r.sourceType}): ${r.failureReason ?? 'outside tolerance'}`,
        data: { venue: r.venue, case: r.case, sourceType: r.sourceType, rulesVersion: r.rulesVersion, reason: r.failureReason },
        urgent: false,
      }),
    );
}

/** Liquidations of watched wallets (ledger) — size as a RANGE only. Fixture addresses never appear in the ledger. */
export function liquidationEvents(liq: readonly LedgerRecord[], watched: ReadonlySet<string>): InkEvent[] {
  return liq
    .filter((r) => watched.has(r.wallet.toLowerCase()))
    .map((r) =>
      ev({
        id: `liq|${r.id}`,
        type: 'wallet.liquidated',
        at: r.at,
        block: r.block,
        subject: short(r.wallet),
        text: `${short(r.wallet)} was liquidated on ${r.venue === 'tydro' ? 'Tydro' : 'Nado'}${r.sizeBand ? ` (size range ${r.sizeBand})` : ''}`,
        data: { wallet: r.wallet.toLowerCase(), venue: r.venue, sizeBand: r.sizeBand, family: r.family, tx: r.tx, aegisBefore: r.aegis.before?.hullTemp ?? null },
        urgent: true,
      }),
    );
}

export interface FeedInput {
  oracle?: OracleWatch | null;
  changes?: readonly ChangeRecord[];
  agg?: readonly AggPoint[];
  liquidations?: readonly LedgerRecord[];
  verification?: readonly VerificationRecord[];
  /** only events at or after this time (ms) */
  since?: number;
}

/** Every Ink-wide event, newest first, unique by id. */
export function inkEvents(o: FeedInput): InkEvent[] {
  const all = [...oracleEvents(o.oracle ?? null), ...changeEvents(o.changes ?? []), ...stressEvents(o.agg ?? []), ...cascadeEvents(o.liquidations ?? []), ...verificationEvents(o.verification ?? [])];
  const seen = new Set<string>();
  return all
    .filter((e) => Number.isFinite(e.at) && e.at >= (o.since ?? 0))
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}
