/**
 * LIQUIDATION LEDGER, CASCADES, ACCOUNTABILITY (pure; no IO). Release 2 of the INTEL expansion.
 *
 *  Ledger          every actual Tydro and Nado liquidation on Ink, from the protocols' own events (ink-io
 *                  liquidations.ts), with what Phrourax had recorded about that wallet before it happened.
 *  Cascades        liquidations grouped by a published, versioned, deterministic rule (time proximity), with the
 *                  reasons for each grouping. Grouping is not causation and is never presented as such.
 *  Accountability  Phrourax's own warnings (a wallet recorded as NEAR LIQUIDATION) scored against what actually
 *                  happened: with denominators, sample sizes and the versions they ran under — never a bare %.
 *
 * Privacy: public files carry size RANGES and percentages, never balances or health factors. Liquidations are
 * historical public transactions; the ledger is ordered by time and never ranks active wallets.
 */
import type { HullTemp, Tag } from '@aegis/pose';
import type { SizeBand } from '@aegis/glyphs';
import { type WalletState } from './history.js';

export const LEDGER = {
  VERSION: 'ledger-1.0.0',
  CASCADE_VERSION: 'cascade-1.0.0',
  ACCOUNT_VERSION: 'acct-1.0.0',
  /** evaluation windows (hours) */
  WINDOWS_H: [1, 6, 24, 168] as const,
  /** below this many cases a rate is shown with its counts and marked "too few to judge" */
  MIN_SAMPLE: 30,
  /** cascade rule: consecutive liquidations no more than this far apart belong to one cluster … */
  CASCADE_GAP_MIN: 30,
  /** … and a cluster needs at least this many liquidations to be called a cascade */
  CASCADE_MIN_EVENTS: 3,
  /** a cascade "centres on" an asset family only when at least this share of its liquidations are in it */
  CASCADE_FAMILY_SHARE: 0.7,
  /** the peak is the busiest window of this length */
  CASCADE_PEAK_MIN: 10,
} as const;

export type Venue = 'tydro' | 'nado';

export interface PriorState {
  /** false = Phrourax wasn't recording yet, so this liquidation can't be used to judge Phrourax */
  evaluable: boolean;
  why: string;
  /** the last state the hourly scan recorded for this wallet BEFORE the liquidation block */
  before: { hullTemp: HullTemp; primary: Tag | null; rulesVersion: string; block: number; at: number } | null;
  /** start of the uninterrupted NEAR LIQUIDATION streak that ran up to the liquidation (null = no such streak) */
  nearSince: number | null;
  /** start of the uninterrupted WATCH-or-worse streak */
  watchSince: number | null;
  /** true when the streak reaches back to the first recorded row (it may have started earlier: lead is "at least") */
  leadIsMinimum: boolean;
}

export interface LedgerRecord {
  id: string;
  venue: Venue;
  tx: string;
  block: number;
  at: number;
  /** liquidated wallet (Tydro user, or the owner of the Nado subaccount) — shown shortened */
  wallet: string;
  subaccountKind: 'default' | 'isolated' | 'other' | null;
  /** Tydro: collateral and debt assets · Nado: the product */
  collateral: string | null;
  debt: string | null;
  product: string | null;
  family: string | null;
  isEncodedSpread: boolean | null;
  /** size RANGE, and what it was measured from; null = couldn't be derived (see `unavailable`) */
  sizeBand: SizeBand | null;
  sizeBasis: string | null;
  /** Tydro: collateral seized ÷ debt repaid − 1, at the block's own oracle prices (includes any protocol fee) */
  impliedBonusPct: number | null;
  aegis: PriorState;
  completeness: 'COMPLETE' | 'PARTIAL';
  /** fields that couldn't be derived reliably — shown as unavailable, never guessed */
  unavailable: string[];
  source: string;
  v: { ledger: string; reader: string; rules: string };
}

export interface LedgerFile {
  v: 1;
  kind: 'aegis-liquidations';
  chainId: 57073;
  month: string;
  records: LedgerRecord[];
}

export const ledgerPath = (month: string) => `history/liq/${month}.json` as const;
export const warnPath = (month: string) => `history/warn/${month}.json` as const;
export const forecastPath = (month: string) => `history/forecast/${month}.json` as const;
export const ACCOUNT_PATH = 'history/accountability.json' as const;

export function isLedgerFile(x: unknown): x is LedgerFile {
  const f = x as LedgerFile;
  return !!f && f.v === 1 && f.kind === 'aegis-liquidations' && Array.isArray(f.records);
}

/** Idempotent: a liquidation (tx + log index) is recorded once, whatever order runs and backfills arrive in. */
export function appendLedger(file: unknown, month: string, recs: readonly LedgerRecord[]): LedgerFile {
  const base: LedgerFile = isLedgerFile(file) && file.month === month ? { ...file, records: [...file.records] } : { v: 1, kind: 'aegis-liquidations', chainId: 57073, month, records: [] };
  const seen = new Set(base.records.map((r) => r.id));
  for (const r of recs) if (!seen.has(r.id)) (seen.add(r.id), base.records.push(r));
  base.records.sort((a, b) => a.block - b.block || a.id.localeCompare(b.id));
  return base;
}

/* ───────────────────────── what Phrourax knew before ───────────────────────── */

/**
 * From a wallet's recorded timeline (history.ts), what Phrourax had recorded before a liquidation at `block`.
 * Only rows strictly before the liquidation block count. A liquidation before recording began is not evaluable.
 */
export function priorState(timeline: readonly WalletState[], block: number, recordingStart: { block: number } | null): PriorState {
  if (!recordingStart || block <= recordingStart.block) {
    return { evaluable: false, why: 'before Phrourax began recording — not used to judge Phrourax', before: null, nearSince: null, watchSince: null, leadIsMinimum: false };
  }
  const rows = timeline.filter((s) => s.block < block);
  const last = rows[rows.length - 1];
  if (!last) {
    return { evaluable: true, why: 'Phrourax had no recorded position for this wallet before it was liquidated (not found, or no position when scanned)', before: null, nearSince: null, watchSince: null, leadIsMinimum: false };
  }
  const streak = (ok: (h: HullTemp) => boolean) => {
    if (!ok(last.hullTemp) || last.primary === 'EMPTY') return { since: null as number | null, minimum: false };
    let i = rows.length - 1;
    while (i > 0 && ok(rows[i - 1]!.hullTemp) && rows[i - 1]!.primary !== 'EMPTY') i--;
    return { since: rows[i]!.at, minimum: i === 0 };
  };
  const near = streak((h) => h === 'CRITICAL');
  const watch = streak((h) => h === 'CRITICAL' || h === 'ELEVATED');
  return {
    evaluable: true,
    why: near.since !== null ? 'recorded NEAR LIQUIDATION before it happened' : watch.since !== null ? 'recorded WATCH (not near) before it happened' : 'recorded without a warning before it happened',
    before: { hullTemp: last.hullTemp, primary: last.primary, rulesVersion: last.rulesVersion, block: last.block, at: last.at },
    nearSince: near.since,
    watchSince: watch.since,
    leadIsMinimum: near.since !== null ? near.minimum : watch.minimum,
  };
}

export const leadHours = (r: LedgerRecord, kind: 'near' | 'watch' = 'near'): number | null => {
  const s = kind === 'near' ? r.aegis.nearSince : r.aegis.watchSince;
  return s === null ? null : Math.max(0, (r.at - s) / 3_600_000);
};

/* ───────────────────────── warnings (for accountability) ───────────────────────── */

/** [address, block, unix seconds, kind ('T' entered NEAR / 'B' already NEAR when recording began), primary idx, band idx, venue flags, rules idx] */
export type WarnRow = [string, number, number, 'T' | 'B', number, number, number, number];

export interface WarnFile {
  v: 1;
  kind: 'aegis-warnings';
  chainId: 57073;
  month: string;
  rules: string[];
  rows: WarnRow[];
}

export function isWarnFile(x: unknown): x is WarnFile {
  const f = x as WarnFile;
  return !!f && f.v === 1 && f.kind === 'aegis-warnings' && Array.isArray(f.rows) && Array.isArray(f.rules);
}

export interface Warning {
  wallet: string;
  block: number;
  at: number;
  kind: 'T' | 'B';
  primary: number;
  band: number;
  venues: { tydro: boolean; nado: boolean };
  rulesVersion: string;
}

export function appendWarnings(file: unknown, month: string, add: ReadonlyArray<Omit<Warning, 'rulesVersion'> & { rulesVersion: string }>): WarnFile {
  const base: WarnFile = isWarnFile(file) && file.month === month ? { ...file, rules: [...file.rules], rows: [...file.rows] } : { v: 1, kind: 'aegis-warnings', chainId: 57073, month, rules: [], rows: [] };
  const seen = new Set(base.rows.map((r) => `${r[0]}|${r[1]}`));
  for (const w of add) {
    const k = `${w.wallet}|${w.block}`;
    if (seen.has(k)) continue;
    seen.add(k);
    let vi = base.rules.indexOf(w.rulesVersion);
    if (vi < 0) (base.rules.push(w.rulesVersion), (vi = base.rules.length - 1));
    base.rows.push([w.wallet, w.block, Math.floor(w.at / 1000), w.kind, w.primary, w.band, (w.venues.tydro ? 2 : 0) | (w.venues.nado ? 4 : 0), vi]);
  }
  base.rows.sort((a, b) => a[1] - b[1]);
  return base;
}

export function readWarnings(files: readonly unknown[]): Warning[] {
  const out: Warning[] = [];
  for (const f of files) {
    if (!isWarnFile(f)) continue;
    for (const r of f.rows) out.push({ wallet: r[0], block: r[1], at: r[2] * 1000, kind: r[3], primary: r[4], band: r[5], venues: { tydro: (r[6] & 2) === 2, nado: (r[6] & 4) === 4 }, rulesVersion: f.rules[r[7]] ?? '?' });
  }
  return out.sort((a, b) => a.block - b.block);
}

/* ───────────────────────── analytics ───────────────────────── */

export interface Rate {
  num: number;
  den: number;
  /** null when den is 0 */
  rate: number | null;
  /** den < MIN_SAMPLE: shown with its counts, labelled too few to judge */
  lowSample: boolean;
}
export const rate = (num: number, den: number, min: number = LEDGER.MIN_SAMPLE): Rate => ({ num, den, rate: den ? num / den : null, lowSample: den < min });

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const count = <T>(xs: readonly T[], key: (x: T) => string) => {
  const m: Record<string, number> = {};
  for (const x of xs) m[key(x)] = (m[key(x)] ?? 0) + 1;
  return m;
};

export function ledgerSummary(recs: readonly LedgerRecord[]) {
  const evaluable = recs.filter((r) => r.aegis.evaluable);
  const leads = evaluable.map((r) => leadHours(r)).filter((x): x is number => x !== null);
  return {
    total: recs.length,
    byVenue: count(recs, (r) => r.venue),
    byFamily: count(recs, (r) => r.family ?? 'unknown'),
    bySize: count(recs, (r) => r.sizeBand ?? 'unavailable'),
    byDay: count(recs, (r) => new Date(r.at).toISOString().slice(0, 10)),
    partial: recs.filter((r) => r.completeness === 'PARTIAL').length,
    evaluable: evaluable.length,
    beforeRecording: recs.length - evaluable.length,
    warnedNear: evaluable.filter((r) => r.aegis.nearSince !== null).length,
    warnedWatchOnly: evaluable.filter((r) => r.aegis.nearSince === null && r.aegis.watchSince !== null).length,
    notWarned: evaluable.filter((r) => r.aegis.nearSince === null && r.aegis.watchSince === null).length,
    notSeen: evaluable.filter((r) => r.aegis.before === null).length,
    leadHoursMedian: median(leads),
    leadHours: leads.sort((a, b) => a - b),
  };
}

/* ───────────────────────── cascades ───────────────────────── */

export interface Cascade {
  id: string;
  version: string;
  start: number;
  end: number;
  ids: string[];
  size: number;
  venues: Record<string, number>;
  families: Record<string, number>;
  /** a family holding ≥ CASCADE_FAMILY_SHARE of the liquidations, else null */
  centredOn: { family: string; share: number } | null;
  peak: { at: number; count: number };
  /** why these were grouped — the rule, in words */
  reasons: string[];
  /** true when the grouping rests on timing alone (no common family) or spans both venues */
  uncertain: boolean;
}

/**
 * Deterministic grouping (cascade-1.0.0): sort by time; a liquidation joins the current cluster when it comes no
 * more than CASCADE_GAP_MIN minutes after the previous one; clusters of ≥ CASCADE_MIN_EVENTS are cascades.
 * Same input → same output, always. Timing is the only grouping signal; families and venues are described, never
 * used to claim a cause.
 */
export function cascades(recs: readonly LedgerRecord[], o: Partial<typeof LEDGER> = {}): Cascade[] {
  const gap = (o.CASCADE_GAP_MIN ?? LEDGER.CASCADE_GAP_MIN) * 60_000;
  const min = o.CASCADE_MIN_EVENTS ?? LEDGER.CASCADE_MIN_EVENTS;
  const share = o.CASCADE_FAMILY_SHARE ?? LEDGER.CASCADE_FAMILY_SHARE;
  const peakMs = (o.CASCADE_PEAK_MIN ?? LEDGER.CASCADE_PEAK_MIN) * 60_000;
  const sorted = [...recs].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const groups: LedgerRecord[][] = [];
  for (const r of sorted) {
    const g = groups[groups.length - 1];
    if (g && r.at - g[g.length - 1]!.at <= gap) g.push(r);
    else groups.push([r]);
  }
  return groups
    .filter((g) => g.length >= min)
    .map((g) => {
      const families = count(g, (r) => r.family ?? 'unknown');
      const venues = count(g, (r) => r.venue);
      const top = Object.entries(families).sort((a, b) => b[1] - a[1])[0]!;
      const centredOn = top[0] !== 'unknown' && top[1] / g.length >= share ? { family: top[0], share: top[1] / g.length } : null;
      let peak = { at: g[0]!.at, count: 0 };
      for (let i = 0; i < g.length; i++) {
        let j = i;
        while (j < g.length && g[j]!.at - g[i]!.at <= peakMs) j++;
        if (j - i > peak.count) peak = { at: g[i]!.at, count: j - i };
      }
      const reasons = [`${g.length} liquidations, each within ${gap / 60_000} minutes of the one before (rule ${LEDGER.CASCADE_VERSION})`];
      if (centredOn) reasons.push(`${Math.round(centredOn.share * 100)}% of them in the ${centredOn.family} family`);
      else reasons.push('no single asset family dominates — grouped by timing only');
      if (Object.keys(venues).length > 1) reasons.push('spans both Tydro and Nado');
      reasons.push('Grouping shows they happened together; it does not establish a common cause.');
      return {
        id: g[0]!.id,
        version: LEDGER.CASCADE_VERSION,
        start: g[0]!.at,
        end: g[g.length - 1]!.at,
        ids: g.map((r) => r.id),
        size: g.length,
        venues,
        families,
        centredOn,
        peak,
        reasons,
        uncertain: !centredOn || Object.keys(venues).length > 1,
      };
    })
    .sort((a, b) => b.start - a.start);
}

/* ───────────────────────── accountability ───────────────────────── */

export interface WindowScore {
  hours: number;
  /** warnings old enough to judge at this window, and how many were followed by that wallet's liquidation */
  precision: Rate;
  /** warnings younger than the window — not yet judged */
  pending: number;
  /** evaluable liquidations where Phrourax had recorded NEAR for at least this long before */
  leadAtLeast: Rate;
}

export interface Breakdown {
  key: string;
  /** liquidations warned (NEAR before) / evaluable liquidations */
  recall: Rate;
  /** warnings followed within 24 h / warnings judged */
  precision24: Rate;
}

export interface Accountability {
  v: 1;
  kind: 'aegis-accountability';
  version: string;
  generatedAt: string;
  recordingStart: string | null;
  definitions: Record<string, string>;
  liquidations: { total: number; evaluable: number; beforeRecording: number; notSeen: number; partial: number };
  warnings: { total: number; atRecordingStart: number };
  /** liquidations with NEAR recorded before / evaluable liquidations */
  recall: Rate;
  /** liquidations with only WATCH (no NEAR) before */
  watchOnly: Rate;
  missed: Rate;
  leadHoursMedian: number | null;
  windows: WindowScore[];
  byVenue: Breakdown[];
  bySize: Breakdown[];
  byType: Breakdown[];
  byFamily: Array<{ key: string; recall: Rate }>;
  byRules: Breakdown[];
  limitations: string[];
}

const BAND_NAMES: readonly SizeBand[] = ['dust', '<1k', '1–10k', '10–100k', '100k+'];

/**
 * Score Phrourax's warnings against what happened. Definitions (published with the result):
 *  - warning: the hourly scan recorded a wallet entering NEAR LIQUIDATION (or already NEAR when recording began)
 *  - followed within W: that wallet was liquidated in (warning, warning + W]
 *  - warned before a liquidation: Phrourax's last recorded state before the liquidation block was NEAR
 *  - evaluable liquidation: after recording began (earlier ones can't judge Phrourax and are excluded, but counted)
 */
export function scoreAccountability(o: { warnings: readonly Warning[]; liquidations: readonly LedgerRecord[]; nowMs: number; recordingStart: string | null; tags: readonly string[]; min?: number }): Accountability {
  const min = o.min ?? LEDGER.MIN_SAMPLE;
  const liqs = o.liquidations;
  const ev = liqs.filter((r) => r.aegis.evaluable);
  const liqByWallet = new Map<string, number[]>();
  for (const r of liqs) liqByWallet.set(r.wallet, [...(liqByWallet.get(r.wallet) ?? []), r.at]);
  const followed = (w: Warning, hours: number) => (liqByWallet.get(w.wallet) ?? []).some((t) => t > w.at && t <= w.at + hours * 3_600_000);
  const judged = (w: Warning, hours: number) => o.nowMs - w.at >= hours * 3_600_000;
  const warnedNear = (r: LedgerRecord) => r.aegis.nearSince !== null;

  const windows: WindowScore[] = LEDGER.WINDOWS_H.map((h) => {
    const j = o.warnings.filter((w) => judged(w, h));
    return {
      hours: h,
      precision: rate(j.filter((w) => followed(w, h)).length, j.length, min),
      pending: o.warnings.length - j.length,
      leadAtLeast: rate(ev.filter((r) => (leadHours(r) ?? -1) >= h).length, ev.length, min),
    };
  });
  const breakdown = <K extends string>(keyL: (r: LedgerRecord) => K, keyW: (w: Warning) => K): Breakdown[] => {
    const keys = new Set<string>([...ev.map(keyL), ...o.warnings.map(keyW)]);
    return [...keys].sort().map((k) => {
      const l = ev.filter((r) => keyL(r) === k);
      const w = o.warnings.filter((x) => keyW(x) === k && judged(x, 24));
      return { key: k, recall: rate(l.filter(warnedNear).length, l.length, min), precision24: rate(w.filter((x) => followed(x, 24)).length, w.length, min) };
    });
  };
  const leads = ev.map((r) => leadHours(r)).filter((x): x is number => x !== null);
  const fam = new Set(ev.map((r) => r.family ?? 'unknown'));
  return {
    v: 1,
    kind: 'aegis-accountability',
    version: LEDGER.ACCOUNT_VERSION,
    generatedAt: new Date(o.nowMs).toISOString(),
    recordingStart: o.recordingStart,
    definitions: {
      warning: 'The hourly scan recorded the wallet entering NEAR LIQUIDATION (or already NEAR when recording began).',
      'followed within W': 'That wallet was liquidated within W hours after the warning.',
      'warned before': "Phrourax's last recorded state before the liquidation block was NEAR LIQUIDATION.",
      evaluable: 'A liquidation after Phrourax began recording. Earlier ones are counted but excluded from every rate.',
      'lead time': 'From the start of the uninterrupted NEAR streak to the liquidation.',
    },
    liquidations: { total: liqs.length, evaluable: ev.length, beforeRecording: liqs.length - ev.length, notSeen: ev.filter((r) => r.aegis.before === null).length, partial: liqs.filter((r) => r.completeness === 'PARTIAL').length },
    warnings: { total: o.warnings.length, atRecordingStart: o.warnings.filter((w) => w.kind === 'B').length },
    recall: rate(ev.filter(warnedNear).length, ev.length, min),
    watchOnly: rate(ev.filter((r) => !warnedNear(r) && r.aegis.watchSince !== null).length, ev.length, min),
    missed: rate(ev.filter((r) => !warnedNear(r) && r.aegis.watchSince === null).length, ev.length, min),
    leadHoursMedian: median(leads),
    windows,
    byVenue: breakdown(
      (r) => r.venue,
      (w) => (w.venues.tydro && w.venues.nado ? 'both' : w.venues.tydro ? 'tydro' : 'nado'),
    ),
    bySize: breakdown(
      (r) => r.sizeBand ?? 'unavailable',
      (w) => BAND_NAMES[w.band] ?? 'unavailable',
    ),
    byType: breakdown(
      (r) => r.aegis.before?.primary ?? 'none recorded',
      (w) => (w.primary >= 0 ? (o.tags[w.primary] ?? '?') : 'none'),
    ),
    byFamily: [...fam].sort().map((k) => {
      const l = ev.filter((r) => (r.family ?? 'unknown') === k);
      return { key: k, recall: rate(l.filter(warnedNear).length, l.length, min) };
    }),
    byRules: breakdown(
      (r) => r.aegis.before?.rulesVersion ?? 'none recorded',
      (w) => w.rulesVersion,
    ),
    limitations: [
      'The hourly scan records each wallet once an hour: a wallet that goes from safe to liquidated inside one hour can only be a miss.',
      'Only wallets Phrourax has found can be warned; a liquidation of a wallet it never saw counts as a miss ("not seen").',
      'Warnings are scored against liquidations only. A warned wallet that added collateral and survived is a correct warning acted on, but counts as "not followed".',
      'Scenario forecasts (Pressure Map) are recorded but not scored yet: scoring them needs recorded prices (Oracle Watch, a later release).',
      'Different rules versions are reported separately; never pooled as if identical.',
    ],
  };
}

/* ───────────────────────── forecasts (recorded now, scored once prices are recorded) ───────────────────────── */

export interface ForecastRecord {
  at: string;
  block: number;
  v: { rules: string; engine: string; stress: string };
  /** Nado open-interest coverage at the time (share), null if not measured */
  coverage: number | null;
  population: number;
  confidence: 'NORMAL' | 'REDUCED';
  /** predicted wallet counts per scenario × size floor — counts only */
  scenarios: Array<{ dir: string; sign: 'down' | 'up'; pct: number; material: string; population: number; near: number; liquidatable: number; affected: number }>;
}

export interface ForecastFile {
  v: 1;
  kind: 'aegis-forecasts';
  month: string;
  records: ForecastRecord[];
}

export function appendForecast(file: unknown, month: string, r: ForecastRecord): ForecastFile {
  const f = file as ForecastFile;
  const base: ForecastFile = f && f.v === 1 && f.kind === 'aegis-forecasts' && f.month === month && Array.isArray(f.records) ? { ...f, records: [...f.records] } : { v: 1, kind: 'aegis-forecasts', month, records: [] };
  if (!base.records.some((x) => x.block === r.block)) base.records.push(r);
  return base;
}
