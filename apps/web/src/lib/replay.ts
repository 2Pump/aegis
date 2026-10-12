/**
 * Replay step 1 — what oracle prices did around a cascade, from the hourly price readings (never interpolated).
 * Pure: the points and the symbol names are passed in.
 */
import type { PricePoint } from '@aegis/census';
import { familyOf } from '@aegis/pose';

export const REPLAY_PRICE = {
  /** a reading counts as "just before" / "just after" only within this distance of the cascade */
  NEAR_MS: 2 * 3_600_000,
  /** moves smaller than this are not worth naming */
  MIN_MOVE: 0.001,
  TOP: 3,
} as const;

export type PriceStep =
  | { kind: 'before-recording' }
  | { kind: 'no-readings' }
  | { kind: 'flat'; from: number; to: number }
  | { kind: 'moves'; from: number; to: number; moves: Array<{ name: string; pct: number }>; family?: { name: string; share: number; moves: Array<{ name: string; pct: number }> } };

/** "tydro:WETH" → "WETH"; "nado:12" → its symbol when known, else "Nado #12"; "pyth:…" is skipped (an external reference) */
export function priceName(key: string, nadoSymbols: ReadonlyMap<number, string>): string | null {
  const [src, id] = key.split(':');
  if (src === 'tydro') return id === 'USDT' ? 'USDT0' : id!;
  if (src === 'nado') return nadoSymbols.get(Number(id)) ?? `Nado #${id}`;
  return null;
}

/**
 * `centredOn`: the family most of the cascade's liquidations were in (if any) — its own prices are shown first,
 * whatever their size, because they are the relevant ones; the largest moves elsewhere follow.
 */
export function priceStep(points: readonly PricePoint[], start: number, end: number, nadoSymbols: ReadonlyMap<number, string>, centredOn: { family: string; share: number } | null = null): PriceStep {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  if (!sorted.length || end < sorted[0]!.at) return { kind: 'before-recording' };
  const before = sorted.filter((p) => p.at <= start && start - p.at <= REPLAY_PRICE.NEAR_MS).at(-1);
  const after = sorted.find((p) => p.at >= end && p.at - end <= REPLAY_PRICE.NEAR_MS);
  if (!before || !after || before === after) return { kind: 'no-readings' };
  const seen = new Set<string>();
  const all: Array<{ name: string; pct: number }> = [];
  for (const [k, v0] of Object.entries(before.p)) {
    const v1 = after.p[k];
    const name = priceName(k, nadoSymbols);
    if (!name || v1 === undefined || !(v0 > 0) || seen.has(name)) continue;
    seen.add(name);
    all.push({ name, pct: v1 / v0 - 1 });
  }
  const byMove = (a: { pct: number }, b: { pct: number }) => Math.abs(b.pct) - Math.abs(a.pct);
  const fam = centredOn ? all.filter((m) => familyOf(m.name).family === centredOn.family).sort(byMove).slice(0, REPLAY_PRICE.TOP) : [];
  const famNames = new Set(fam.map((m) => m.name));
  const moves = all.filter((m) => !famNames.has(m.name) && Math.abs(m.pct) >= REPLAY_PRICE.MIN_MOVE).sort(byMove).slice(0, REPLAY_PRICE.TOP);
  const family = centredOn && fam.length ? { name: centredOn.family, share: centredOn.share, moves: fam } : undefined;
  return moves.length || family ? { kind: 'moves', from: before.at, to: after.at, moves, ...(family ? { family } : {}) } : { kind: 'flat', from: before.at, to: after.at };
}

const pctText = (x: number) => (Math.abs(x) < 0.0005 ? '0.0%' : `${x > 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`);

export function priceStepText(s: PriceStep, when: (ms: number) => string): string {
  if (s.kind === 'before-recording') return 'Not recorded — this was before Phrourax started recording oracle prices.';
  if (s.kind === 'no-readings') return 'No hourly price reading close enough before and after it to compare.';
  if (s.kind === 'flat') return `No oracle price moved more than ${REPLAY_PRICE.MIN_MOVE * 100}% between the readings at ${when(s.from)} and ${when(s.to)}.`;
  const list = (ms: Array<{ name: string; pct: number }>) => ms.map((m) => `${m.name} ${pctText(m.pct)}`).join(' · ');
  const span = `${when(s.from)} → ${when(s.to)} (hourly readings)`;
  if (!s.family) return `Largest oracle price moves, ${span}: ${list(s.moves)}`;
  const fam = `${s.family.name} family (${Math.round(s.family.share * 100)}% of these liquidations), ${span}: ${list(s.family.moves)}`;
  return s.moves.length ? `${fam}. Largest moves elsewhere: ${list(s.moves)}` : fam;
}
