import { useMemo, useState } from 'react';
import {
  DIRECTIONS,
  canBeLiquidated,
  classify,
  confidenceOf,
  directionMatch,
  directionScenario,
  exposedTo,
  nadoBuffer,
  shockBook,
  stressState,
  thresholds,
  tydroLiqDistance,
  type Book,
  type Direction,
  type Pose,
  type StressState,
  type Thresholds,
} from '@aegis/pose';
import { RISK_LABEL, TAG_LABEL } from '@aegis/glyphs';
import { Panel, TEMP_RAIL } from './bits';
import { fmtPct } from '../lib/fmt';

/*
 * STRESS TEST — this wallet under hypothetical moves, from its current reading.
 * Same engine as the Pressure Map (packages/pose/src/scenario.ts): a shocked copy of the book run through the same
 * risk lines. Approximately, never a prediction. Nothing here leaves the page.
 */

const MAX = 50;
const PRESETS: Array<{ label: string; dir: string; pct: number }> = [
  { label: 'BTC −10%', dir: 'BTC', pct: -10 },
  { label: 'ETH −10%', dir: 'ETH', pct: -10 },
  { label: 'All crypto −20%', dir: 'CRYPTO', pct: -20 },
  { label: 'Everything but stables −30%', dir: 'RISK', pct: -30 },
  { label: 'BTC +15%', dir: 'BTC', pct: 15 },
  { label: 'USDe depeg −5%', dir: 'USDE', pct: -5 },
];

interface Row {
  d: Direction;
  sign: 1 | -1;
  t: Thresholds;
  /** which venue trips first at the Near-liquidation move */
  venue: string | null;
}

const stateText = (st: StressState) => (st.liquidatable ? 'Liquidatable' : RISK_LABEL[st.hullTemp]);
const moveText = (sign: 1 | -1, v: number | null) => (v === null ? `beyond ${sign < 0 ? '−' : '+'}${MAX}%` : v === 0 ? 'already' : `≈ ${sign < 0 ? '−' : '+'}${v}%`);

export function StressTest({ book, pose, idx }: { book: Book; pose: Pose; idx: string }) {
  const conf = useMemo(() => confidenceOf(book), [book]);
  const exposed = useMemo(() => canBeLiquidated(book), [book]);
  const rows: Row[] = useMemo(() => {
    if (!exposed || conf.confidence === 'UNSUPPORTED') return [];
    const out: Row[] = [];
    for (const d of DIRECTIONS) {
      if (!exposedTo(book, directionMatch(d))) continue;
      for (const sign of d.downOnly ? ([-1] as const) : ([-1, 1] as const)) {
        const t = thresholds(book, (p) => directionScenario(d, sign * p), MAX);
        if (t.WATCH === null && t.NEAR === null && t.LIQ === null) continue;
        let venue: string | null = null;
        if (t.NEAR !== null) {
          const w = classify(shockBook(book, directionScenario(d, sign * Math.max(t.NEAR, 0)))).metrics.wound;
          venue = w.tydro && w.nado ? 'Tydro and Nado' : w.tydro ? 'Tydro' : w.nado ? 'Nado' : null;
        }
        out.push({ d, sign, t, venue });
      }
    }
    const k = (r: Row) => [r.t.NEAR ?? 999, r.t.LIQ ?? 999, r.t.WATCH ?? 999];
    return out.sort((a, b) => {
      const x = k(a), y = k(b);
      return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
    });
  }, [book, exposed, conf.confidence]);

  const [dir, setDir] = useState('CRYPTO');
  const [pct, setPct] = useState(-10);
  const custom = useMemo(() => {
    const d = DIRECTIONS.find((x) => x.id === dir)!;
    const p = d.downOnly ? -Math.abs(pct) : pct;
    return { d, p, st: stressState(shockBook(book, directionScenario(d, p))) };
  }, [book, dir, pct]);

  const t = book.tydro.status === 'OK' ? book.tydro.data : null;
  const n = book.nado.status === 'OK' ? book.nado.data : null;
  const hf = t?.hf ?? null;
  const liq = tydroLiqDistance(hf);
  const buf = nadoBuffer(n);
  const worst = rows.find((r) => r.t.NEAR !== null && r.t.NEAR > 0) ?? null;

  return (
    <Panel idx={idx} title="Stress test" rail={TEMP_RAIL[pose.hullTemp]} testId="stress-test" right={<span className="mono">a simulation, not a prediction</span>}>
      <dl className="kv tight">
        <dt>risk now</dt><dd className="mono">{RISK_LABEL[pose.hullTemp]} · {pose.primary ? TAG_LABEL[pose.primary] : 'Unclassified'}</dd>
        <dt>Tydro health factor</dt><dd className="num">{hf === null ? (t ? 'no debt' : '—') : hf.toFixed(3)}</dd>
        <dt>Tydro distance to liquidation</dt><dd className="num">{liq === null ? '—' : fmtPct(liq)}</dd>
        <dt>Nado maintenance buffer</dt><dd className="num">{buf === null ? '—' : fmtPct(buf)}</dd>
        <dt>model</dt>
        <dd className="mono" data-testid="stress-confidence">
          {conf.confidence === 'MODELLED' ? 'modelled from this reading' : conf.confidence === 'APPROXIMATE' ? `approximate — ${conf.why.join('; ')}` : `can't simulate — ${conf.why.join('; ')}`}
        </dd>
      </dl>

      {!exposed ? (
        <div className="dim st-note" data-testid="stress-none">No debt and no perps, so price moves alone can't liquidate this wallet. There's nothing to stress.</div>
      ) : conf.confidence === 'UNSUPPORTED' ? (
        <div className="banner st-note">No stress numbers: part of this wallet couldn't be read, and AEGIS won't guess the missing half.</div>
      ) : (
        <>
          {worst ? (
            <p className="st-lead" data-testid="stress-lead">
              Based on the current observable position and prices, an approximately <b>{worst.t.NEAR}% {worst.d.label} {worst.sign < 0 ? (worst.d.downOnly ? 'depeg' : 'decline') : 'rise'}</b> would move this
              {worst.venue ? ` ${worst.venue}` : ''} position into near liquidation.
            </p>
          ) : rows.some((r) => r.t.NEAR === 0) ? (
            <p className="st-lead">This wallet is already near liquidation.</p>
          ) : (
            <p className="st-lead">No single move of up to {MAX}% takes this wallet near liquidation, based on the current reading.</p>
          )}
          {rows.length ? (
            <div className="table-wrap">
              <table className="t" data-testid="stress-rows">
                <thead>
                  <tr><th>If</th><th>Watch</th><th>Near liquidation</th><th>Liquidatable</th><th>Venue</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.d.id}${r.sign}`}>
                      <td className="mono">{r.d.label} {r.sign < 0 ? (r.d.downOnly ? 'depegs' : 'falls') : 'rises'}</td>
                      <td className="num">{moveText(r.sign, r.t.WATCH)}</td>
                      <td className="num">{moveText(r.sign, r.t.NEAR)}</td>
                      <td className="num">{moveText(r.sign, r.t.LIQ)}</td>
                      <td className="mono">{r.venue ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="dim st-note">No move of up to {MAX}% in any direction changes this wallet's risk.</div>
          )}

          <div className="st-cap">Preset scenarios</div>
          <ul className="st-presets">
            {PRESETS.map((p) => {
              const d = DIRECTIONS.find((x) => x.id === p.dir)!;
              const st = stressState(shockBook(book, directionScenario(d, p.pct)));
              return (
                <li key={p.label}>
                  <span className="mono">{p.label}</span>
                  <b className={`st-state ${st.liquidatable ? 'liq' : st.hullTemp}`}>{stateText(st)}</b>
                </li>
              );
            })}
          </ul>

          <div className="st-cap">Your own scenario</div>
          <div className="st-custom">
            <select value={dir} onChange={(e) => setDir(e.target.value)} aria-label="What moves">
              {DIRECTIONS.map((d) => (
                <option key={d.id} value={d.id}>{d.label}</option>
              ))}
            </select>
            <input
              type="number"
              min={-95}
              max={100}
              step={1}
              value={pct}
              onChange={(e) => {
                const v = Math.round(Number(e.target.value));
                setPct(Number.isFinite(v) ? Math.max(-95, Math.min(100, v)) : 0);
              }}
              aria-label="Move in percent (negative = falls)"
            />
            <span className="mono">%</span>
            <span className="mono">→</span>
            <b className={`st-state ${custom.st.liquidatable ? 'liq' : custom.st.hullTemp}`} data-testid="stress-custom">{stateText(custom.st)}</b>
          </div>
          <div className="faint st-note">
            Approximately, from this reading only: funding and interest over time, Nado spread pairs, Tydro's per-asset thresholds and oracle lag aren't modelled. Not financial advice.
          </div>
        </>
      )}
    </Panel>
  );
}
