/**
 * INTEL → ORACLES (Release 3, oracle-1.0.0). The prices Tydro and Nado actually use, next to Tydro's own source
 * contract and an external reference (Pyth) where one exists on Ink for that exact asset. Each feed is an
 * observation, not the truth. Written by the hourly census (history/oracle/latest.json, history/prices/<month>.json).
 */
import { useMemo, useState } from 'react';
import { ORACLE, type AssetRow, type OracleStatus, type OracleWatch, type PricePoint } from '@aegis/census';
import { INK_EXPLORER } from '@aegis/ink-io';
import { Panel } from './bits';
import { RangePicker, when } from './HistoryBits';
import { useOracleWatch, usePrices, type Range } from '../lib/history';
import { WELL_ON } from '../lib/census';

export const STATUS_COLOR: Record<OracleStatus | 'RESOLVED', string> = {
  OK: 'var(--cyan)',
  UNAVAILABLE: 'var(--slate)',
  WARN: 'var(--amber)',
  JUMP: '#B8612A',
  STALE: '#B8612A',
  DIVERGENT: 'var(--red)',
  DEPEG: 'var(--red)',
  INVALID: 'var(--red)',
  RESOLVED: 'var(--cyan)',
};
const STATUS_HELP: Record<OracleStatus, string> = {
  OK: 'every check that could run passed',
  UNAVAILABLE: 'at least one check could not run (shown, not assumed fine)',
  WARN: 'a small deviation, or an unusual setting',
  JUMP: `moved ≥ ${ORACLE.JUMP_PCT}% since the previous run`,
  STALE: `source not updated for over ${ORACLE.STALE_H} h`,
  DIVERGENT: `≥ ${ORACLE.DIVERGE_PCT}% apart from another source`,
  DEPEG: `stablecoin ≥ ${ORACLE.PEG_BREAK_PCT}% from $1`,
  INVALID: 'the protocol price is missing or not a positive number',
};
const STALE_VIEW_H = 3;

export const StatusChip = ({ s }: { s: OracleStatus | 'RESOLVED' }) => (
  <span className="mono oracle-chip" style={{ borderColor: STATUS_COLOR[s], color: STATUS_COLOR[s] }}>{s}</span>
);

export function price(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const d = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 0.1 ? 4 : 6;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}
const ExplorerAddr = ({ a }: { a: string | null }) =>
  a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (
    <a className="mono" href={`${INK_EXPLORER}/address/${a}`} target="_blank" rel="noreferrer" title={a}>{a.slice(0, 8)}…{a.slice(-6)}</a>
  ) : (
    <span className="mono faint">{a ?? '—'}</span>
  );

export function OraclesPanel() {
  const s = useOracleWatch();
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Panel title="Oracle Watch" rail="var(--cyan)" testId="intel-oracles" right={<span className="mono">{ORACLE.VERSION}</span>}>
        {s.status === 'loading' ? <div className="dim" role="status">Loading the latest reading…</div> : null}
        {s.status === 'error' ? <div className="banner red" role="alert">Couldn't load ({s.message}). Nothing is shown rather than a guess.</div> : null}
        {s.status === 'none' ? (
          <div className="banner" data-testid="oracles-not-started">
            NOT RECORDING YET — the hourly scan starts reading every price source after this update. Nothing before that is shown, backfilled or made up.
          </div>
        ) : null}
        {s.status === 'ok' ? <Watch w={s.v} /> : null}
      </Panel>
      {s.status === 'ok' ? <PriceHistory w={s.v} /> : null}
      {s.status === 'ok' ? <Events w={s.v} /> : null}
    </div>
  );
}

function Watch({ w }: { w: OracleWatch }) {
  const ageH = (Date.now() - w.at) / 3_600_000;
  const counts = (Object.entries(w.summary) as Array<[OracleStatus, number]>).filter(([, n]) => n > 0);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="faint mono" style={{ fontSize: 11 }} data-testid="oracles-asof">
        Read at block {w.block.toLocaleString('en-US')} · {when(w.at)}
        {ageH > STALE_VIEW_H ? <b style={{ color: 'var(--amber)' }}> · STALE — {ageH.toFixed(0)} h old; the scan hasn&apos;t refreshed it</b> : null}
      </div>
      <p className="dim" style={{ fontSize: 13, lineHeight: 1.55, margin: 0 }}>
        The prices the protocols actually use, next to the contract behind each one and an independent feed where one exists on Ink for that exact asset. Each feed is an observation, not the truth — a disagreement says one of them is wrong, not which.
      </p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }} data-testid="oracles-summary">
        {counts.map(([k, n]) => (
          <span key={k} title={STATUS_HELP[k]}><StatusChip s={k} /> <span className="mono">{n}</span></span>
        ))}
      </div>
      {w.errors.length ? <div className="banner" role="status">Some sources couldn&apos;t be read this run: {w.errors.join('; ')}</div> : null}
      <div className="table-wrap">
        <table className="t oracle-table" data-testid="oracles-table">
          <thead>
            <tr><th>Asset</th><th className="hide-narrow">Used by</th><th>Tydro</th><th>Nado</th><th>External</th><th className="hide-narrow">Status</th></tr>
          </thead>
          <tbody>
            {w.rows.map((r) => <AssetRowView key={r.asset} r={r} />)}
          </tbody>
        </table>
      </div>
      <div className="note-text">Click an asset for every check, its source contract and — where a divergence exists — what it would move.</div>
      {w.nadoOther.length ? (
        <details>
          <summary className="mono dim" style={{ fontSize: 11, cursor: 'pointer' }}>Nado products with no Tydro counterpart ({w.nadoOther.length}) — price only</summary>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Product</th><th>Type</th><th>Nado oracle price</th></tr></thead>
              <tbody>
                {w.nadoOther.map((n) => (
                  <tr key={n.productId}><td className="mono">{n.symbol ?? `#${n.productId}`}</td><td className="mono">{n.type}</td><td className="num">{price(n.price)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="note-text">Product 0 is Nado&apos;s quote (USDT0) — its unit of account, $1 by definition, so it isn&apos;t peg-checked.</div>
        </details>
      ) : null}
      <details>
        <summary className="mono dim" style={{ fontSize: 11, cursor: 'pointer' }}>Sources and thresholds</summary>
        <ul className="dim" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
          {w.sources.map((x) => <li key={x.name}><b>{x.name}</b> — {x.detail}</li>)}
          <li>Assets are matched across venues by token contract address, never by ticker.</li>
          <li>Thresholds: warn at {ORACLE.WARN_PCT}% apart, divergent at {ORACLE.DIVERGE_PCT}%; stablecoins warn at {ORACLE.PEG_WARN_PCT}% from $1, depeg at {ORACLE.PEG_BREAK_PCT}%; stale after {ORACLE.STALE_H} h; jump at {ORACLE.JUMP_PCT}% between runs.</li>
          <li>Events fire on entering a problem, not every run; the same problem isn&apos;t repeated within {ORACLE.COOLDOWN_H} h, and &quot;resolved&quot; needs {ORACLE.RESOLVE_RUNS} clean runs in a row.</li>
        </ul>
      </details>
    </div>
  );
}

function AssetRowView({ r }: { r: AssetRow }) {
  const [open, setOpen] = useState(false);
  const pctOf = (k: string) => r.checks.find((c) => c.kind === k)?.pct ?? null;
  const sgn = (p: number | null) => (p === null ? '' : ` (${p >= 0 ? '+' : ''}${p.toFixed(2)}%)`);
  return (
    <>
      <tr className="oracle-row" data-testid={`oracle-row-${r.symbol}`}>
        <td>
          <button type="button" className="linklike mono" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? '▾' : '▸'} {r.symbol}
          </button>{' '}
          <span className="show-narrow"><StatusChip s={r.status} /></span>
        </td>
        <td className="mono dim hide-narrow">{r.usedBy.join(' · ')}</td>
        <td className="num">{price(r.tydro?.price)}</td>
        <td className="num">{r.nado ? <>{price(r.nado.price)}<span className="faint">{sgn(pctOf('cross-venue'))}</span></> : <span className="faint">—</span>}</td>
        <td className="num">
          {r.external ? (r.external.note ? <span className="faint" title={r.external.note}>{/dormant/.test(r.external.note) ? 'dormant on Ink' : 'not compared'}</span> : <>{price(r.external.price)}<span className="faint">{sgn(pctOf('external'))}</span></>) : <span className="faint">none on Ink</span>}
        </td>
        <td className="hide-narrow"><StatusChip s={r.status} /></td>
      </tr>
      {open ? (
        <tr className="oracle-detail">
          <td colSpan={6}>
            <div className="stack oracle-detail-body" style={{ gap: 10 }}>
              <ul className="oracle-checks">
                {r.checks.map((c, i) => (
                  <li key={i}><StatusChip s={c.status} /> <span className="mono faint">{c.kind}</span> {c.text}</li>
                ))}
                {!r.checks.length ? <li className="faint">No checks could run.</li> : null}
              </ul>
              <dl className="kv tight">
                <dt>Token</dt><dd><ExplorerAddr a={r.asset} /></dd>
                <dt>Tydro source</dt>
                <dd>
                  <ExplorerAddr a={r.tydro?.source ?? null} />
                  {r.tydro?.sourceDescription ? <span className="faint"> · {r.tydro.sourceDescription}</span> : null}
                  {r.tydro?.sourceAnswer !== null && r.tydro?.sourceAnswer !== undefined ? <span className="faint"> · answers {price(r.tydro.sourceAnswer)}</span> : null}
                  {r.tydro?.sourceKind === 'adapter' ? <span className="faint"> · an adapter</span> : null}
                  {r.tydro?.capped ? <span style={{ color: 'var(--amber)' }}> · price cap ACTIVE</span> : null}
                  {r.tydro?.sourceUpdatedAt && r.tydro.sourceKind !== 'adapter' ? <span className="faint"> · updated {when(r.tydro.sourceUpdatedAt)}</span> : null}
                </dd>
                {r.tydro?.via?.length ? (
                  <>
                    <dt>Feeds under it</dt>
                    <dd>
                      {r.tydro.via.map((v) => (
                        <div key={v.role + v.address}>
                          <ExplorerAddr a={v.address} /> <span className="faint">{v.description ?? ''} · {v.role} · {v.updatedAt ? `updated ${when(v.updatedAt)}` : 'update time not exposed'}</span>
                          {(v.under ?? []).map((u) => (
                            <div key={u.role + u.address} style={{ paddingLeft: 14 }}>
                              <span className="faint">↳ </span><ExplorerAddr a={u.address} /> <span className="faint">{u.description ?? ''} · {u.role} · {u.updatedAt ? `updated ${when(u.updatedAt)}` : 'update time not exposed'}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </dd>
                  </>
                ) : null}
                <dt>Nado</dt><dd>{r.nado ? <span className="mono">product {r.nado.productId} · update time not exposed on-chain</span> : <span className="faint">not listed on Nado (by token address)</span>}</dd>
                {r.perp ? (<><dt>Nado perp</dt><dd className="mono">{r.perp.symbol} {price(r.perp.price)} <span className="faint">— basis vs spot, information only (not an oracle error)</span></dd></>) : null}
                {r.external ? (
                  <>
                    <dt>External</dt>
                    <dd>
                      {r.external.note ? (
                        // not compared (dormant or not pushed lately): its last price is history, never shown as current
                        <span className="faint" data-testid={`oracle-ext-stale-${r.symbol}`}>
                          Pyth {r.external.key}/USD last price {price(r.external.price)} <b>(stale — not a current price)</b>
                        </span>
                      ) : (
                        <>
                          Pyth {r.external.key}/USD {price(r.external.price)}
                          {r.external.conf ? <span className="faint"> ±{price(r.external.conf)}</span> : null}
                        </>
                      )}
                      {r.external.publishTime ? <span className="faint"> · published {when(r.external.publishTime)}</span> : null}
                      <div className="faint">{r.external.relation}{r.external.note ? ` · ${r.external.note}` : ''}</div>
                    </dd>
                  </>
                ) : null}
              </dl>
              {r.impact && !WELL_ON ? <div className="note-text">What this divergence would move is locked with the well until the readings are verified (no counts shown).</div> : null}
              {r.impact && WELL_ON ? (
                <div className="oracle-impact" data-testid={`oracle-impact-${r.symbol}`}>
                  <div className="panel-title" style={{ marginBottom: 4 }}>If the protocol price converged — {r.impact.direction} {r.impact.sign === 'down' ? '−' : '+'}{r.impact.pct}%</div>
                  <div style={{ fontSize: 13 }}>
                    All sizes: <b>{r.impact.byFloor['0'].newlyNear}</b> wallets newly near liquidation, <b>{r.impact.byFloor['0'].newlyLiquidatable}</b> newly liquidatable (of {r.impact.byFloor['0'].population}).
                    {' '}≥ $1k: <b>{r.impact.byFloor['1k'].newlyNear}</b> / <b>{r.impact.byFloor['1k'].newlyLiquidatable}</b> (of {r.impact.byFloor['1k'].population}).
                  </div>
                  <div className="note-text">{r.impact.note} Basis: {r.impact.basis}. Pressure snapshot block {r.impact.pressureBlock.toLocaleString('en-US')}.</div>
                </div>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/* ───────── price history ───────── */

const W = 1000;
function PriceChart({ series, from, to, label }: { series: Array<{ name: string; color: string; dash?: string; points: Array<{ t: number; v: number }> }>; from: number; to: number; label: string }) {
  const all = series.flatMap((s) => s.points.map((p) => p.v));
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi - lo < hi * 0.002) {
    const mid = (hi + lo) / 2;
    lo = mid * 0.999;
    hi = mid * 1.001;
  }
  const H = 180;
  const x = (t: number) => ((t - from) / Math.max(1, to - from)) * W;
  const y = (v: number) => H - 16 - ((v - lo) / (hi - lo)) * (H - 30);
  // a missing run (> 3 h between points) breaks the line rather than drawing across it
  const path = (pts: Array<{ t: number; v: number }>) => pts.map((p, i) => `${i === 0 || p.t - pts[i - 1]!.t > 3 * 3_600_000 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  return (
    <div>
      <svg className="hist-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} style={{ height: H }}>
        <rect x="0" y="0" width={W} height={H} fill="var(--field)" />
        {series.map((s) => (
          <path key={s.name} d={path(s.points)} fill="none" stroke={s.color} strokeWidth="2" strokeDasharray={s.dash} vectorEffect="non-scaling-stroke" />
        ))}
        {series.map((s) => (s.points.length <= 2 ? s.points.map((p) => <circle key={`${s.name}${p.t}`} cx={x(p.t)} cy={y(p.v)} r="4" fill={s.color} />) : null))}
      </svg>
      <div className="hist-axis mono faint"><span>{price(hi)} top</span><span>{price(lo)} bottom</span></div>
      <div className="hist-legend">
        {series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}
      </div>
    </div>
  );
}

/** not pushed on Ink for over a day (or never): not a reference (the same rule as the watch itself) */
const pythDormant = (e: NonNullable<AssetRow['external']>, at: number) => e.publishTime === null || at - e.publishTime > ORACLE.REF_DORMANT_H * 3_600_000;

function PriceHistory({ w }: { w: OracleWatch }) {
  const [range, setRange] = useState<Range>('7d');
  const [sym, setSym] = useState(w.rows.find((r) => r.symbol === 'WETH')?.symbol ?? w.rows[0]?.symbol ?? '');
  const h = usePrices(range);
  const row = w.rows.find((r) => r.symbol === sym);
  const series = useMemo(() => {
    if (h.status !== 'ok' || !row) return [];
    const key = (pts: PricePoint[], k: string) => pts.filter((p) => p.p[k] !== undefined).map((p) => ({ t: p.at, v: p.p[k]! }));
    const tk = `tydro:${row.symbol === 'USDT0' ? 'USDT' : row.symbol}`;
    // drawn back to front: the protocol price last, so it stays visible where the sources agree
    const out: Array<{ name: string; color: string; dash?: string; points: Array<{ t: number; v: number }> }> = [];
    // a dormant Pyth feed repeats one old number every hour — drawn, it would read as a live price line; it's left out
    if (row.external && !pythDormant(row.external, w.at)) out.push({ name: `Pyth ${row.external.key}/USD (when pushed)`, color: 'var(--amber)', dash: '6 5', points: key(h.points, `pyth:${row.external.key}`) });
    if (row.nado) out.push({ name: `Nado product ${row.nado.productId}`, color: 'var(--violet)', points: key(h.points, `nado:${row.nado.productId}`) });
    out.push({ name: 'Tydro (protocol price)', color: 'var(--cyan)', points: key(h.points, tk) });
    return out.filter((s) => s.points.length);
  }, [h, row]);
  return (
    <Panel title="Price history" rail="var(--cyan)" testId="oracles-history" right={<span className="mono">one reading per hourly scan</span>}>
      <div className="stack" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <RangePicker value={range} onChange={setRange} testId="oracles-range" />
          <label className="mono dim" style={{ fontSize: 12 }}>
            Asset{' '}
            <select value={sym} onChange={(e) => setSym(e.target.value)} data-testid="oracles-asset">
              {w.rows.map((r) => <option key={r.asset} value={r.symbol}>{r.symbol}</option>)}
            </select>
          </label>
        </div>
        {h.status === 'loading' ? <div className="dim" role="status">Loading…</div> : null}
        {h.status === 'error' ? <div className="banner red" role="alert">Couldn&apos;t load ({h.message}).</div> : null}
        {h.status === 'none' ? <div className="dim">No prices recorded in this range yet — recording began with Oracle Watch. Nothing earlier is reconstructed.</div> : null}
        {h.status === 'ok' && series.length ? <PriceChart series={series} from={h.from} to={h.to} label={`${sym} prices over time from ${series.map((s) => s.name).join(', ')}`} /> : null}
        {h.status === 'ok' && !series.length ? <div className="dim">No recorded prices for {sym} in this range.</div> : null}
        {row?.external && pythDormant(row.external, w.at) ? <div className="note-text" data-testid="oracles-pyth-dormant">Pyth {row.external.key}/USD isn&apos;t drawn: it&apos;s dormant on Ink (not pushed for over {ORACLE.REF_DORMANT_H} h), so its number is old, not a price reading.</div> : null}
        <div className="note-text">Hourly readings only — anything that happened between two scans isn&apos;t in this chart. Pyth is a pull oracle: it&apos;s drawn only while someone keeps pushing it on Ink.</div>
      </div>
    </Panel>
  );
}

function Events({ w }: { w: OracleWatch }) {
  const [all, setAll] = useState(false);
  const ev = all ? w.events : w.events.slice(0, 20);
  return (
    <Panel title="Oracle events" rail="var(--cyan)" testId="oracles-events" right={<span className="mono">newest first</span>}>
      {!w.events.length ? (
        <div className="dim" data-testid="oracles-no-events">No events recorded — every problem Phrourax has seen since recording began would be listed here, with the time and block it was first seen.</div>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>When (UTC)</th><th className="hide-narrow">Block</th><th>Event</th><th /></tr></thead>
              <tbody>
                {ev.map((e) => (
                  <tr key={e.id}>
                    <td className="mono">{when(e.at)}</td>
                    <td className="mono hide-narrow">{e.block.toLocaleString('en-US')}</td>
                    <td className="wrap-text oracle-event-text">{e.text}</td>
                    <td><StatusChip s={e.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {w.events.length > 20 ? (
            <button type="button" className="sq-btn" onClick={() => setAll(!all)}>{all ? 'SHOW FEWER' : `SHOW ALL ${w.events.length}`}</button>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
