/**
 * Coverage: does the census see (nearly) everyone?
 *
 * The protocols publish their own totals on-chain:
 *  - Tydro: every aToken / variableDebtToken has totalSupply()  → all supplied / all borrowed, per asset
 *  - Nado:  every spot product carries total deposits / borrows, every perp product its open interest
 * On a full sweep we add up what the wallets we know hold and compare. If a big slice is missing,
 * there are accounts we haven't discovered — and the per-asset gap says where to look.
 *
 * Aggregates only: nothing here is per wallet. And only the PERCENTAGES are published (CoveragePublic);
 * dollar totals and per-asset gaps stay in the job log, in line with the census rule "no dollar figures in the public file".
 */
import type { ProtocolTotals } from '@aegis/ink-io';
import type { Book } from '@aegis/pose';

export type { ProtocolTotals };

export interface CoverageLine {
  /** Tydro symbol (e.g. "USDC") or Nado product label (e.g. "spot 0" / "perp 2 BTC-PERP") */
  key: string;
  venue: 'tydro' | 'nado';
  side: 'supply' | 'debt' | 'deposits' | 'borrows' | 'longs' | 'shorts';
  /** what the protocol says in total, USD */
  totalUsd: number;
  /** what the wallets we know add up to, USD */
  oursUsd: number;
}

export interface Coverage {
  block: number;
  at: string;
  /** wallets whose read failed in this sweep (their share is missing from "ours") */
  darkWallets: number;
  totals: {
    tydroSupply: { oursUsd: number; totalUsd: number };
    tydroDebt: { oursUsd: number; totalUsd: number };
    nadoDeposits: { oursUsd: number; totalUsd: number };
    /** perp open interest as Nado reports it vs the longs we see (and the shorts, as a cross-check) */
    nadoOpenInterest: { oursLongUsd: number; oursShortUsd: number; totalUsd: number };
  };
  /** the largest gaps (≥ $1k), biggest first — where undiscovered accounts would be */
  gaps: CoverageLine[];
}

/** Running sums over the books read in one sweep. Keys: Tydro symbol / Nado productId. */
export class CoverageAcc {
  tydroSupply = new Map<string, number>(); // token units
  tydroDebt = new Map<string, number>();
  nadoDeposits = new Map<number, number>();
  nadoBorrows = new Map<number, number>();
  nadoLongs = new Map<number, number>(); // base units
  nadoShorts = new Map<number, number>();
  dark = 0;

  add(book: Book): void {
    const bump = <K>(m: Map<K, number>, k: K, v: number) => m.set(k, (m.get(k) ?? 0) + v);
    if (book.tydro.status === 'OK') {
      for (const l of book.tydro.data.supplies) bump(this.tydroSupply, l.symbol, Math.abs(l.amount));
      for (const l of book.tydro.data.debts) bump(this.tydroDebt, l.symbol, Math.abs(l.amount));
    }
    if (book.nado.status === 'OK') this.addNado(book.nado.data.spots, book.nado.data.perps);
    if (book.tydro.status === 'DARK' || book.nado.status === 'DARK') this.dark++;
  }

  /** Nado balances only (protocol accounts, which have no Tydro side). */
  addNado(spots: ReadonlyArray<{ productId: number; amount: number }>, perps: ReadonlyArray<{ productId: number; sizeBase: number }>): void {
    const bump = <K>(m: Map<K, number>, k: K, v: number) => m.set(k, (m.get(k) ?? 0) + v);
    {
      for (const s of spots) {
        if (s.amount > 0) bump(this.nadoDeposits, s.productId, s.amount);
        else if (s.amount < 0) bump(this.nadoBorrows, s.productId, -s.amount);
      }
      for (const p of perps) {
        if (p.sizeBase > 0) bump(this.nadoLongs, p.productId, p.sizeBase);
        else if (p.sizeBase < 0) bump(this.nadoShorts, p.productId, -p.sizeBase);
      }
    }
  }
}

export function buildCoverage(acc: CoverageAcc, t: ProtocolTotals, at = new Date().toISOString()): Coverage {
  const lines: CoverageLine[] = [];
  for (const r of t.tydro) {
    lines.push({ key: r.symbol, venue: 'tydro', side: 'supply', totalUsd: r.supplied * r.priceUsd, oursUsd: (acc.tydroSupply.get(r.symbol) ?? 0) * r.priceUsd });
    lines.push({ key: r.symbol, venue: 'tydro', side: 'debt', totalUsd: r.borrowed * r.priceUsd, oursUsd: (acc.tydroDebt.get(r.symbol) ?? 0) * r.priceUsd });
  }
  for (const r of t.nadoSpot) {
    lines.push({ key: r.label, venue: 'nado', side: 'deposits', totalUsd: r.deposits * r.priceUsd, oursUsd: (acc.nadoDeposits.get(r.productId) ?? 0) * r.priceUsd });
    lines.push({ key: r.label, venue: 'nado', side: 'borrows', totalUsd: r.borrows * r.priceUsd, oursUsd: (acc.nadoBorrows.get(r.productId) ?? 0) * r.priceUsd });
  }
  let oiTotal = 0, oiLong = 0, oiShort = 0;
  for (const r of t.nadoPerp) {
    // Nado's perp `openInterest` counts BOTH sides (longs + shorts), unlike Vertex's longs-only counter. Measured
    // 2026-10-03 at block ~57.57M: every market's wallet longs and shorts were each just under half of it (BTC 48.2% /
    // 45.7%, ETH 48.5% / 49.5%, HYPE 48.1% / 49.9%), never above 50%, while the dollars of longs and shorts we see were
    // nearly equal (BTC $10.6M / $10.1M). So each side is compared with half of it.
    const total = (r.openInterest * r.priceUsd) / 2;
    const longs = (acc.nadoLongs.get(r.productId) ?? 0) * r.priceUsd;
    const shorts = (acc.nadoShorts.get(r.productId) ?? 0) * r.priceUsd;
    oiTotal += total;
    oiLong += longs;
    oiShort += shorts;
    lines.push({ key: r.label, venue: 'nado', side: 'longs', totalUsd: total, oursUsd: longs });
    lines.push({ key: r.label, venue: 'nado', side: 'shorts', totalUsd: total, oursUsd: shorts });
  }
  const sumOf = (venue: CoverageLine['venue'], side: CoverageLine['side']) => {
    const ls = lines.filter((l) => l.venue === venue && l.side === side);
    return { oursUsd: ls.reduce((s, l) => s + l.oursUsd, 0), totalUsd: ls.reduce((s, l) => s + l.totalUsd, 0) };
  };
  const gaps = lines
    .filter((l) => l.totalUsd - l.oursUsd >= 1_000)
    .sort((a, b) => b.totalUsd - b.oursUsd - (a.totalUsd - a.oursUsd))
    .slice(0, 12)
    .map((l) => ({ ...l, totalUsd: Math.round(l.totalUsd), oursUsd: Math.round(l.oursUsd) }));
  return {
    block: t.block,
    at,
    darkWallets: acc.dark,
    totals: {
      tydroSupply: sumOf('tydro', 'supply'),
      tydroDebt: sumOf('tydro', 'debt'),
      nadoDeposits: sumOf('nado', 'deposits'),
      nadoOpenInterest: { oursLongUsd: oiLong, oursShortUsd: oiShort, totalUsd: oiTotal },
    },
    gaps,
  };
}

/** What goes into the public snapshot: shares only (0..1, 3 decimals), no dollar figures. null = protocol total is zero. */
export interface CoveragePublic {
  block: number;
  at: string;
  darkWallets: number;
  share: {
    tydroSupply: number | null;
    tydroDebt: number | null;
    nadoDeposits: number | null;
    nadoOpenInterestLongs: number | null;
    nadoOpenInterestShorts: number | null;
  };
}

const share = (ours: number, total: number) => (total > 0 ? Math.round((ours / total) * 1000) / 1000 : null);

export function publicCoverage(c: Coverage): CoveragePublic {
  const t = c.totals;
  return {
    block: c.block,
    at: c.at,
    darkWallets: c.darkWallets,
    share: {
      tydroSupply: share(t.tydroSupply.oursUsd, t.tydroSupply.totalUsd),
      tydroDebt: share(t.tydroDebt.oursUsd, t.tydroDebt.totalUsd),
      nadoDeposits: share(t.nadoDeposits.oursUsd, t.nadoDeposits.totalUsd),
      nadoOpenInterestLongs: share(t.nadoOpenInterest.oursLongUsd, t.nadoOpenInterest.totalUsd),
      nadoOpenInterestShorts: share(t.nadoOpenInterest.oursShortUsd, t.nadoOpenInterest.totalUsd),
    },
  };
}

/** 0.973 → "97.3%" ; null → "—" */
export function sharePct(x: number | null): string {
  return x === null ? '—' : `${(x * 100).toFixed(1)}%`;
}

/** 0.973 → "97.3%" ; no total → "—" */
export function coveragePct(ours: number, total: number): string {
  if (!(total > 0)) return '—';
  return `${Math.min(999, (ours / total) * 100).toFixed(1)}%`;
}

export function coverageSummary(c: Coverage): string {
  const t = c.totals;
  return [
    `Tydro supply ${coveragePct(t.tydroSupply.oursUsd, t.tydroSupply.totalUsd)}`,
    `Tydro debt ${coveragePct(t.tydroDebt.oursUsd, t.tydroDebt.totalUsd)}`,
    `Nado deposits ${coveragePct(t.nadoDeposits.oursUsd, t.nadoDeposits.totalUsd)}`,
    `Nado open interest ${coveragePct(t.nadoOpenInterest.oursLongUsd, t.nadoOpenInterest.totalUsd)} (longs) / ${coveragePct(t.nadoOpenInterest.oursShortUsd, t.nadoOpenInterest.totalUsd)} (shorts)`,
  ].join(' · ');
}
