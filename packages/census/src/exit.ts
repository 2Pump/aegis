/**
 * EXIT RISK (pure; no IO) — `exit-1.0.0`. An ESTIMATE of how hard it would be to close a Nado perp position yourself,
 * from the order book Phrourax records every ~10 minutes (depth.ts → depth/latest.json).
 *
 * Closing a LONG sells into the bids; closing a SHORT buys from the asks. The recorder keeps, per side, the USD resting
 * within 10 / 50 / 100 / 200 bps of the mid. From that:
 *   - how much of the position the book could take within 0.5% of the price, now and at the side's thinnest in 24 h;
 *   - roughly how far from the mid the LAST part of a full close would fill (interpolated between the recorded bands;
 *     "beyond 2%" when the book within 2% is smaller than the position).
 *
 * What it is NOT:
 *   - a liquidation cost: Nado liquidates through its own liquidators, not by selling into this book;
 *   - a quote: books refill and empty quickly; this is what was resting at the last reading;
 *   - a change to Safe / Watch / Near liquidation, which come from the rules alone.
 * Privacy: it uses a position's size, so it is computed in the visitor's browser on the paid wallet page only. It is
 * never written to a file, the API or a share card.
 * When the reading is missing, empty, stale or failed its units check, the answer is UNAVAILABLE — never a guess.
 */
import { DEPTH, type DepthLatest } from './depth.js';

export const EXIT = {
  VERSION: 'exit-1.0.0',
  /** a book reading older than this is too old to estimate from */
  MAX_AGE_MIN: 30,
  /** LOW: the position is at most this share of what sits within 0.5% now… */
  LOW_SHARE_NOW: 0.25,
  /** …and no more than what sat there at the side's thinnest in the last 24 h */
  LOW_SHARE_LOW24: 1,
} as const;

export type ExitLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export type ExitEstimate =
  | { ok: false; reason: string }
  | {
      ok: true;
      level: ExitLevel;
      /** USD on the side you'd trade into, within 10 / 50 / 100 / 200 bps of the mid, at the last reading */
      bookUsd: number[];
      /** that side within 50 bps at its thinnest in the last 24 h (null: no history yet) */
      low24Usd: number | null;
      /** position ÷ book within 0.5% now */
      shareNow: number;
      /** roughly how far from the mid the last part of a full close would fill, bps; null = beyond 200 bps */
      reachBps: number | null;
      /** the reply hit its level limit inside the bands, so the book may be deeper than shown */
      atLeast: boolean;
      side: 'bids' | 'asks';
      readAt: string;
    };

const BAND50 = DEPTH.BANDS_BPS.indexOf(50);

/** bps at which the cumulative book reaches `usd`, interpolated between (0,0) and the recorded bands */
export function reachBps(bookUsd: readonly number[], usd: number): number | null {
  let px = 0;
  let pu = 0;
  for (let i = 0; i < DEPTH.BANDS_BPS.length; i++) {
    const b = DEPTH.BANDS_BPS[i]!;
    const u = bookUsd[i] ?? 0;
    if (u >= usd) return u === pu ? b : px + ((usd - pu) / (u - pu)) * (b - px);
    px = b;
    pu = u;
  }
  return null;
}

export function exitEstimate(o: { notionalUsd: number; long: boolean; market: DepthLatest['markets'][number] | undefined; nowMs: number }): ExitEstimate {
  const n = Math.abs(o.notionalUsd);
  if (!(n > 0)) return { ok: false, reason: 'no open position' };
  const m = o.market;
  if (!m || !m.now || !m.at) return { ok: false, reason: 'no order-book reading for this market' };
  if (m.now.mid === null) return { ok: false, reason: 'the order book is empty' };
  if (!m.now.unitsOk) return { ok: false, reason: "the last book failed its units check, so its sizes aren't used" };
  const ageMin = (o.nowMs - Date.parse(m.at)) / 60_000;
  if (!(ageMin <= EXIT.MAX_AGE_MIN)) return { ok: false, reason: `the last order-book reading is ${Math.round(ageMin)} min old` };
  const book = o.long ? m.now.bidUsd : m.now.askUsd;
  const sideIdx = o.long ? 2 : 3;
  const lows = m.hist.map((h) => h[sideIdx]).filter((x): x is number => x !== null && Number.isFinite(x));
  const low24 = lows.length ? Math.min(...lows) : null;
  const in50 = book[BAND50] ?? 0;
  const shareNow = in50 > 0 ? n / in50 : Infinity;
  const reach = reachBps(book, n);
  const widest = book[book.length - 1] ?? 0;
  const level: ExitLevel =
    n > widest ? 'HIGH' : shareNow <= EXIT.LOW_SHARE_NOW && (low24 === null || n <= low24 * EXIT.LOW_SHARE_LOW24) ? 'LOW' : 'MEDIUM';
  return { ok: true, level, bookUsd: [...book], low24Usd: low24, shareNow, reachBps: reach, atLeast: m.now.clipped, side: o.long ? 'bids' : 'asks', readAt: m.at };
}
