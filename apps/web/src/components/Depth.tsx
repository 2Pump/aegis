/**
 * Intel → DEPTH — Nado order books, recorded every ~10 minutes (packages/census/src/depth.ts, docs/DEPTH.md).
 * Everything shown was read from Nado's official order book; medians and lows cover the last 24 h. Nothing is
 * projected, and a book Nado didn't answer is shown as such — never filled in.
 */
import { useMemo, useState } from 'react';
import { DEPTH, summarizeMarket, type MarketSummary } from '@aegis/census';
import { Panel } from './bits';
import { useDepth } from '../lib/history';

const SORTS = [
  ['deep', 'Deepest'],
  ['thin', 'Thinnest'],
  ['spread', 'Widest spread'],
  ['mark', 'Furthest from oracle'],
] as const;
type Sort = (typeof SORTS)[number][0];

const usd = (x: number | null) => {
  if (x === null) return '—';
  if (x >= 1e6) return `$${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(x >= 1e4 ? 0 : 1)}k`;
  return `$${Math.round(x)}`;
};
const bps = (x: number | null, signed = false) => (x === null ? '—' : `${signed && x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(Math.abs(x) >= 100 ? 0 : 1)}`);
const sym = (s: string) => s.replace(/-PERP$/, '');
const hhmm = (iso: string | null) => (iso ? `${iso.slice(11, 16)} UTC` : '—');
const day = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—');

function sorted(rows: MarketSummary[], by: Sort): MarketSummary[] {
  const key = (r: MarketSummary): number | null =>
    by === 'deep' || by === 'thin' ? r.thinMed : by === 'spread' ? r.spreadMed : r.markMax === null ? null : Math.abs(r.markMax);
  const dir = by === 'thin' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1; // unknowns last, always
    return dir * (x - y);
  });
}

export function DepthPanel() {
  const d = useDepth();
  const [by, setBy] = useState<Sort>('deep');
  const rows = useMemo(() => (d.status === 'ok' ? d.v.markets.map((m) => summarizeMarket(m, d.v.updated)) : []), [d]);
  const view = useMemo(() => sorted(rows, by), [rows, by]);

  return (
    <Panel title="Market depth — Nado order books" rail="var(--cyan)" testId="intel-depth" right={<span className="mono">{DEPTH.VERSION}</span>}>
      <div className="stack" style={{ gap: 12 }}>
        <p className="dim" style={{ margin: 0, fontSize: 14 }}>
          Read every ~10 minutes from Nado&apos;s official order book. <b>Depth</b> is the money resting within 0.5% of the price on each side: what a trade can fill against before
          the price moves more than that. <b>Spread</b> is the gap between the best bid and ask, in basis points (1 bp = 0.01%). <b>Nado vs oracle</b> is the book&apos;s mid
          price against the oracle price Nado&apos;s contracts use. Medians and lows cover the last 24 h. Nothing here is a projection.
        </p>
        {d.status === 'loading' ? <div className="dim" role="status">Loading…</div> : null}
        {d.status === 'error' ? <div className="banner red" role="alert">Couldn&apos;t load ({d.message}). Nothing is shown rather than a guess.</div> : null}
        {d.status === 'none' ? (
          <div className="banner" data-testid="depth-not-started">NOT RECORDING YET — the first reading arrives with the next 10-minute run after this update.</div>
        ) : null}
        {d.status === 'ok' ? (
          <>
            <Reach v={d.v} />
            <div className="view-switch" role="group" aria-label="Sort markets">
              {SORTS.map(([k, label]) => (
                <button key={k} className={`sq-btn${by === k ? ' on' : ''}`} aria-pressed={by === k} onClick={() => setBy(k)} data-testid={`depth-sort-${k}`}>
                  {label}
                </button>
              ))}
            </div>
            <div className="table-wrap">
              <table className="t" data-testid="depth-table">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th className="r">Spread (bps)<br /><span className="faint">now · 24 h median</span></th>
                    <th className="r">Depth ±0.5%<br /><span className="faint">bid · ask, now</span></th>
                    <th className="r">Thinner side<br /><span className="faint">24 h median · low</span></th>
                    <th className="r">Nado vs oracle (bps)<br /><span className="faint">now · 24 h widest</span></th>
                  </tr>
                </thead>
                <tbody>
                  {view.map((r) => {
                    const warn = r.markMax !== null && Math.abs(r.markMax) >= DEPTH.MARK_WARN_BPS;
                    return (
                      <tr key={r.p} data-testid={`depth-row-${sym(r.s)}`}>
                        <td className="mono">
                          {sym(r.s)}
                          {r.stale ? <span className="faint" title="Nado didn't answer for this book on the latest run; the figures are its last good reading"> · last read {hhmm(d.v.markets.find((m) => m.p === r.p)?.at ?? null)}</span> : null}
                        </td>
                        <td className="r num">{bps(r.spreadNow)} · <span className="dim">{bps(r.spreadMed)}</span></td>
                        <td className="r num">{usd(r.bidNow)} · {usd(r.askNow)}</td>
                        <td className="r num">{usd(r.thinMed)} · <span className="dim">{usd(r.thinLow)}</span></td>
                        <td className="r num" style={warn ? { color: 'var(--amber)' } : undefined}>
                          {bps(r.markNow, true)} · <span className={warn ? undefined : 'dim'}>{bps(r.markMax, true)}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <ul className="dim" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              <li>Perps only. Gold Nado-vs-oracle figures are {DEPTH.MARK_WARN_BPS} bps (0.3%) or more, the same line Oracle Watch uses.</li>
              <li>Depth is what was resting at that moment. Books refill and empty quickly, so it says how deep a market has been, not what a future trade will get.</li>
              <li>When Nado&apos;s API refuses a request it is counted above as refused. Phrourax never works around it.</li>
            </ul>
          </>
        ) : null}
      </div>
    </Panel>
  );
}

function Reach({ v }: { v: NonNullable<Extract<ReturnType<typeof useDepth>, { status: 'ok' }>['v']> }) {
  const l = v.reach.last24;
  const pct = l.asked ? (l.answered / l.asked) * 100 : 0;
  const all = Object.values(v.reach.days).reduce((a, x) => ({ asked: a.asked + x.asked, answered: a.answered + x.answered }), { asked: 0, answered: 0 });
  return (
    <div className="mono" style={{ fontSize: 12.5 }} data-testid="depth-reach">
      Last 24 h: {l.runs} runs · {l.answered.toLocaleString('en-US')} of {l.asked.toLocaleString('en-US')} books answered ({pct.toFixed(pct === 100 ? 0 : 1)}%)
      {l.refused ? ` · ${l.refused.toLocaleString('en-US')} refused by Nado` : ''}
      {l.failed ? ` · ${l.failed.toLocaleString('en-US')} failed` : ''}
      <span className="dim">
        {' '}· recording since {day(v.reach.firstDay)} ({all.answered.toLocaleString('en-US')} of {all.asked.toLocaleString('en-US')} answered) · latest {hhmm(v.updated)}
      </span>
    </div>
  );
}
