import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { DIRECTIONS, PRIMARY_PRIORITY, SCENARIO_ENGINE_VERSION, RULES } from '@aegis/pose';
import {
  MATERIAL,
  MATERIAL_LABEL,
  STRESS,
  clampQuery,
  pressureCurve,
  queryPressure,
  shareText,
  stressLevel,
  pressureFreshness,
  FRESHNESS,
  type Material,
  type PressureQuery,
  type PressureSnapshot,
  type StressReading,
} from '@aegis/census';
import { TAG_LABEL } from '@aegis/glyphs';
import { Panel } from '../components/bits';
import { WELL_ON, useCensus } from '../lib/census';
import { usePressure } from '../lib/pressure';
import { fmtAge } from '../lib/fmt';
import { useNow } from '../lib/hulls';

/*
 * PRESSURE MAP — what happens to the wallets AEGIS can see if prices move.
 * Everything here is counts from pressure.json (aggregates written by the census full sweep). No wallet is named,
 * ranked or priced. The engine and its limits: packages/pose/src/scenario.ts and docs/PRESSURE.md.
 */

const PRESETS: Array<{ label: string; q: Partial<PressureQuery> }> = [
  { label: 'BTC −10%', q: { dir: 'BTC', sign: 'down', pct: 10 } },
  { label: 'ETH −10%', q: { dir: 'ETH', sign: 'down', pct: 10 } },
  { label: 'All crypto −10%', q: { dir: 'CRYPTO', sign: 'down', pct: 10 } },
  { label: 'All crypto −20%', q: { dir: 'CRYPTO', sign: 'down', pct: 20 } },
  { label: 'Everything but stables −20%', q: { dir: 'RISK', sign: 'down', pct: 20 } },
  { label: 'BTC +10% (shorts)', q: { dir: 'BTC', sign: 'up', pct: 10 } },
  { label: 'Stocks −10%', q: { dir: 'XSTOCK', sign: 'down', pct: 10 } },
  { label: 'USDe depeg −5%', q: { dir: 'USDE', sign: 'down', pct: 5 } },
];

const NARROW: Array<{ v: string; label: string }> = [
  { v: '*', label: 'Every wallet' },
  { v: 'v:tydro', label: 'Tydro only' },
  { v: 'v:nado', label: 'Nado only' },
  { v: 'v:both', label: 'Tydro and Nado' },
  ...[...PRIMARY_PRIORITY, 'WOUNDED' as const].map((t) => ({ v: `t:${t}`, label: `Type: ${TAG_LABEL[t]}` })),
];

const LEVEL_TONE: Record<string, string> = { CALM: 'var(--cyan)', ELEVATED: 'var(--amber)', HIGH: '#fb923c', CRITICAL: 'var(--red)' };

export function PressurePage() {
  const now = useNow(30_000);
  const { state: ps, refresh } = usePressure();
  const census = useCensus();
  if (!WELL_ON) {
    return (
      <div className="stack">
        <h2 className="page">Pressure Map</h2>
        <div className="banner red" data-testid="pressure-locked">Locked with the well until the readings are verified against the official apps.</div>
      </div>
    );
  }
  const cov = census.status === 'ok' ? census.snap.coverage ?? null : null;
  return (
    <div className="stack" data-testid="pressure-page">
      <h2 className="page">Pressure Map</h2>
      <p className="dim pm-intro">
        Model how observable Tydro and Nado positions could react to hypothetical market moves. Scenarios are simulations, not predictions or financial advice.
      </p>
      {ps.status === 'loading' ? <div className="dim">Loading the latest pressure map…</div> : null}
      {ps.status === 'missing' ? (
        <div className="banner" data-testid="pressure-missing">
          No pressure map yet. It's built by the full scan (every 3 hours, every wallet read at one block) and appears after the next one.
        </div>
      ) : null}
      {ps.status === 'error' ? <div className="banner red">Couldn't load the pressure map ({ps.message}). Nothing is shown rather than a guess.</div> : null}
      {ps.status === 'ok' ? (
        <PressureBody
          s={ps.snap}
          now={now}
          oi={cov ? minShare(cov.share.nadoOpenInterestLongs, cov.share.nadoOpenInterestShorts) : null}
          cov={cov}
          wellAt={census.status === 'ok' ? census.snap.generatedAt : null}
          wellBlock={census.status === 'ok' ? census.snap.block : null}
          refreshError={ps.refreshError ?? null}
          onRefresh={refresh}
        />
      ) : null}
    </div>
  );
}

const minShare = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.min(a, b));

function PressureBody({
  s,
  now,
  oi,
  cov,
  wellAt,
  wellBlock,
  refreshError,
  onRefresh,
}: {
  s: PressureSnapshot;
  now: number;
  oi: number | null;
  cov: { share: Record<string, number | null | undefined>; block: number; at: string } | null;
  wellAt: string | null;
  wellBlock: number | null;
  refreshError: string | null;
  onRefresh: () => boolean;
}) {
  const [params, setParams] = useSearchParams();
  const q = clampQuery(
    { dir: params.get('d') ?? undefined, sign: (params.get('s') as 'down' | 'up') ?? undefined, pct: params.get('p') === null ? undefined : Number(params.get('p')), material: (params.get('m') as Material) ?? undefined, dim: params.get('by') ?? undefined },
    s,
  );
  const set = (patch: Partial<PressureQuery>) => {
    const n = clampQuery({ ...q, ...patch }, s);
    setParams({ d: n.dir, s: n.sign, p: String(n.pct), m: n.material, by: n.dim }, { replace: true });
  };
  const reset = () => setParams({}, { replace: true });
  const dir = DIRECTIONS.find((d) => d.id === q.dir)!;
  const r = useMemo(() => queryPressure(s, q), [s, q.dir, q.sign, q.pct, q.material, q.dim]);
  const all = useMemo(() => queryPressure(s, { ...q, material: '0' }), [s, q.dir, q.sign, q.pct, q.dim]);
  const stress = useMemo(() => stressLevel(s, { nowMs: now, oiCoverage: oi }), [s, now, oi]);
  const fresh = pressureFreshness(s, now);
  const stale = fresh.status === 'STALE';
  const [tried, setTried] = useState<string | null>(null);
  const signLabel = q.sign === 'down' ? '−' : '+';
  const scenarioLabel = `${dir.label} ${signLabel}${q.pct}%`;

  return (
    <>
      <section className={`panel pm-fresh ${fresh.status}`} style={{ ['--rail' as string]: fresh.status === 'CURRENT' ? 'var(--cyan)' : fresh.status === 'DELAYED' ? 'var(--amber)' : 'var(--red)' }} data-testid="pressure-freshness" data-status={fresh.status}>
        <div className="rail" aria-hidden />
        <div className="body">
          <div className="pm-fresh-row">
            <b className="pm-fresh-status">{fresh.status}</b>
            <span>
              This map: block {s.block.toLocaleString('en-US')}, read {fmtAge(Date.parse(s.pricesAt ?? s.at), now)} ago — {fresh.why}.
              {wellAt ? ` The well: block ${wellBlock?.toLocaleString('en-US') ?? '—'}, ${fmtAge(Date.parse(wellAt), now)} ago.` : ''}
            </span>
            <button
              type="button"
              className="sq-btn"
              onClick={() => setTried(onRefresh() ? 'checking…' : 'checked less than a minute ago')}
              title="Looks for a newer map file. It never re-reads the chain."
            >
              Check for a newer map
            </button>
            {tried ? <span className="faint">{tried}</span> : null}
          </div>
          <div className="faint pm-fresh-why">
            Why they differ: the well is refreshed every hour, but the Pressure Map needs every wallet read at the same block, which only the full scan does (every 3 hours, about 45 minutes per run). Prices are the venues' own oracle prices at the map's block.
          </div>
          {refreshError ? <div className="banner" data-testid="pressure-refresh-failed">The last refresh failed ({refreshError}). Showing the last good map, with its own age above — nothing was replaced by a guess.</div> : null}
          <div className="mono faint pm-stamp" data-testid="pressure-stamp">
            Based on wallets currently visible to AEGIS · rules {s.rulesVersion}
            {s.rulesVersion !== RULES.RULES_VERSION ? ` (site now on ${RULES.RULES_VERSION})` : ''} · engine {s.engine}
            {s.engine !== SCENARIO_ENGINE_VERSION ? ` (site on ${SCENARIO_ENGINE_VERSION})` : ''} · {STRESS.VERSION} · {FRESHNESS.VERSION}
          </div>
        </div>
      </section>

      <StressPanel stress={stress} stale={stale} asOf={fmtAge(Date.parse(s.pricesAt ?? s.at), now)} />

      <Panel title="Scenario" rail="var(--slate)" testId="pressure-controls">
        <div className="pm-presets" role="group" aria-label="Preset scenarios">
          {PRESETS.map((p) => {
            const on = p.q.dir === q.dir && p.q.sign === q.sign && p.q.pct === q.pct;
            return (
              <button key={p.label} type="button" className={`sq-btn${on ? ' on' : ''}`} aria-pressed={on} onClick={() => set(p.q)}>
                {p.label}
              </button>
            );
          })}
          <button type="button" className="sq-btn" onClick={reset} title="Back to the default view">Reset</button>
        </div>
        <div className="pm-controls">
          <label>
            <span className="pm-cap">What moves</span>
            <select value={q.dir} onChange={(e) => set({ dir: e.target.value })} data-testid="pm-dir">
              {DIRECTIONS.map((d) => (
                <option key={d.id} value={d.id}>{d.label}</option>
              ))}
            </select>
          </label>
          {dir.downOnly ? null : (
            <div className="pm-seg" role="group" aria-label="Direction">
              <span className="pm-cap">Direction</span>
              <div>
                <button type="button" className={`sq-btn${q.sign === 'down' ? ' on' : ''}`} aria-pressed={q.sign === 'down'} onClick={() => set({ sign: 'down' })}>Falls</button>
                <button type="button" className={`sq-btn${q.sign === 'up' ? ' on' : ''}`} aria-pressed={q.sign === 'up'} onClick={() => set({ sign: 'up' })}>Rises</button>
              </div>
            </div>
          )}
          <label className="pm-move">
            <span className="pm-cap">By how much: {q.pct}%</span>
            <input type="range" min={0} max={s.maxPct} step={1} value={q.pct} onChange={(e) => set({ pct: Number(e.target.value) })} aria-label="Move in percent" data-testid="pm-pct" />
          </label>
          <label>
            <span className="pm-cap">Wallet size</span>
            <select value={q.material} onChange={(e) => set({ material: e.target.value as Material })} data-testid="pm-material">
              {MATERIAL.map((m) => (
                <option key={m} value={m}>{MATERIAL_LABEL[m]}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="pm-cap">Narrow to</span>
            <select value={q.dim} onChange={(e) => set({ dim: e.target.value })} data-testid="pm-dim">
              {NARROW.map((n) => (
                <option key={n.v} value={n.v}>{n.label}</option>
              ))}
            </select>
          </label>
        </div>
        {dir.note ? <div className="faint pm-note">{dir.note}.</div> : null}
      </Panel>

      <Panel title={`Under ${scenarioLabel}`} rail="var(--red)" testId="pressure-result" right={<span className="mono">{MATERIAL_LABEL[q.material]} · {NARROW.find((n) => n.v === q.dim)?.label}</span>}>
        <div className="pm-big">
          <div>
            <b className="num" data-testid="pm-affected">{r.affected.toLocaleString('en-US')}</b>
            <span>of {r.population.toLocaleString('en-US')} wallets with debt or perps move closer to liquidation ({r.population ? ((r.affected / r.population) * 100).toFixed(1) : '0.0'}%)</span>
          </div>
          {q.material !== '0' ? (
            <div className="faint">
              All sizes: {all.affected.toLocaleString('en-US')} of {all.population.toLocaleString('en-US')}. The size floor is on; smaller wallets are counted there, not hidden.
            </div>
          ) : null}
        </div>
        <dl className="kv pm-kv">
          <dt>near liquidation now</dt><dd className="num">{(r.now.N + r.now.L).toLocaleString('en-US')}</dd>
          <dt>near liquidation under this scenario</dt><dd className="num">{r.nearUnder.toLocaleString('en-US')}</dd>
          <dt>safe → watch</dt><dd className="num">{r.safeToWatch.toLocaleString('en-US')}</dd>
          <dt>safe → near liquidation</dt><dd className="num">{r.safeToNear.toLocaleString('en-US')}</dd>
          <dt>watch → near liquidation</dt><dd className="num">{r.watchToNear.toLocaleString('en-US')}</dd>
          <dt title="Tydro health factor under 1, or a Nado subaccount's maintenance health under 0">newly liquidatable</dt><dd className="num">{r.newlyLiquidatable.toLocaleString('en-US')}</dd>
          <dt>liquidatable under this scenario</dt><dd className="num">{r.liquidatableUnder.toLocaleString('en-US')}</dd>
        </dl>
      </Panel>

      <Panel title="Where pressure starts" rail="var(--red)" testId="pressure-curve" right={<span className="mono">{dir.label} {dir.downOnly || q.sign === 'down' ? 'falling' : 'rising'} 0–{s.maxPct}%</span>}>
        <Curve s={s} q={q} />
      </Panel>

      <div className="grid two">
        <Panel title="Which asset hurts most" rail="var(--slate)" testId="pressure-families">
          <Families s={s} q={q} onPick={(d) => set({ dir: d })} />
        </Panel>
        <Panel title="Small accounts or material ones?" rail="var(--slate)" testId="pressure-bands">
          <Bands s={s} q={q} />
        </Panel>
      </div>
      <div className="grid two">
        <Panel title="Which venue" rail="var(--slate)" testId="pressure-venues">
          <Breakdown s={s} q={q} rows={NARROW.slice(1, 4)} />
        </Panel>
        <Panel title="Which position types" rail="var(--slate)" testId="pressure-types">
          <Breakdown s={s} q={q} rows={NARROW.slice(4)} />
        </Panel>
      </div>

      <Panel title="What this includes, and what it doesn't" rail="var(--slate)" testId="pressure-coverage">
        <dl className="kv tight">
          <dt>wallets read</dt><dd className="num">{s.population.drawn.toLocaleString('en-US')} with a position, at block {s.block.toLocaleString('en-US')}</dd>
          <dt>simulated</dt><dd className="num">{s.population.exposed.toLocaleString('en-US')} with debt or perps (the rest can't be liquidated by price)</dd>
          <dt>approximate</dt><dd className="num">{s.population.approximate.toLocaleString('en-US')} (mixed Tydro collateral, or Nado weights missing)</dd>
          <dt>couldn't simulate</dt><dd className="num">{s.population.unsupported.toLocaleString('en-US')} (a venue unreadable or a price missing; left out, not guessed)</dd>
          <dt>coverage</dt>
          <dd className="mono">
            {cov
              ? `Tydro ${pctOf(cov.share.tydroSupply)} supplied / ${pctOf(cov.share.tydroDebt)} borrowed · Nado deposits ${pctOf(cov.share.nadoDeposits)} · Nado open longs ${pctOf(cov.share.nadoOpenInterestLongs)} / shorts ${pctOf(cov.share.nadoOpenInterestShorts)} (full scan at block ${cov.block.toLocaleString('en-US')})`
              : 'not measured yet'}{' '}
            · <Link to="/census">Scan</Link>
          </dd>
          <dt>privacy</dt><dd className="dim">Counts only: no wallet is named, ranked or priced. Groups of fewer than {s.privacyMinCell} wallets show their moves rounded up to 10%.</dd>
          <dt>not modelled</dt>
          <dd className="dim">Funding and interest over time, Nado spread pairs, Tydro's per-asset thresholds (one threshold per wallet is assumed when collateral is mixed), oracle lag and market impact. Moves are whole percents up to {s.maxPct}%.</dd>
        </dl>
      </Panel>

      <ShareBox s={s} q={q} stress={stress} />
    </>
  );
}

const pctOf = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);

function StressPanel({ stress, stale, asOf }: { stress: StressReading; stale: boolean; asOf: string }) {
  const tone = stale ? 'var(--ink-faint)' : LEVEL_TONE[stress.level]!;
  return (
    <section className="panel pm-stress" style={{ ['--rail' as string]: tone }} data-testid="stress-level" data-level={stress.level}>
      <div className="rail" aria-hidden />
      <div className="body">
        <h3 className="panel-title">
          Ink stress level
          <span className="right">{stress.version} · a reading of today's positions, not a forecast</span>
        </h3>
        <div className="pm-stress-row">
          <div className="pm-level" style={{ color: tone }}>
            {stress.level}
            {stale ? <div className="pm-asof" data-testid="stress-stale">STALE · as of {asOf} ago, not now</div> : null}
          </div>
          <ul className="pm-why">
            {stress.why.map((w) => (
              <li key={w}>{w}</li>
            ))}
            <li className="faint">
              Measured on the {stress.inputs.population.toLocaleString('en-US')} wallets of at least $1,000 with debt or perps.{' '}
              <Link to="/pressure?d=CRYPTO&s=down&p=10&m=1k&by=*">See the −10% scenario</Link>
            </li>
          </ul>
        </div>
        {stress.confidence === 'REDUCED' ? <div className="banner pm-conf" data-testid="stress-reduced">REDUCED CONFIDENCE — {stress.confidenceWhy.join(' · ')}.</div> : null}
      </div>
    </section>
  );
}

function Curve({ s, q }: { s: PressureSnapshot; q: PressureQuery }) {
  const main = useMemo(() => pressureCurve(s, q), [s, q.dir, q.sign, q.material, q.dim]);
  const tydro = useMemo(() => (q.dim === '*' ? pressureCurve(s, { ...q, dim: 'v:tydro' }) : null), [s, q.dir, q.sign, q.material, q.dim]);
  const nado = useMemo(() => (q.dim === '*' ? pressureCurve(s, { ...q, dim: 'v:nado' }) : null), [s, q.dir, q.sign, q.material, q.dim]);
  // drawn at the box's real width, so the axis text stays readable on a phone
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(Math.max(280, Math.round(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = W < 480 ? 200 : 240, L = 44, R = 12, T = 12, B = 30;
  const max = Math.max(1, ...main.map((p) => p.near));
  const x = (p: number) => L + (p / s.maxPct) * (W - L - R);
  const y = (n: number) => T + (1 - n / max) * (H - T - B);
  const path = (pts: Array<{ pct: number; v: number }>) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.pct).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const ticks = (W < 480 ? [0, 25, 50] : [0, 10, 20, 30, 40, 50]).filter((t) => t <= s.maxPct);
  const yTicks = [0, Math.round(max / 2), max];
  const sign = q.sign === 'down' ? '−' : '+';
  return (
    <div ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="pm-chart" role="img" aria-label={`Wallets near liquidation as the move grows from 0 to ${s.maxPct}%. At ${sign}${q.pct}%: ${main[q.pct]?.near ?? 0}.`}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="rgba(160,175,190,0.12)" />
            <text x={L - 6} y={y(t) + 3} textAnchor="end" className="pm-axis">{t.toLocaleString('en-US')}</text>
          </g>
        ))}
        {ticks.map((t) => (
          <text key={t} x={x(t)} y={H - 10} textAnchor="middle" className="pm-axis">{sign}{t}%</text>
        ))}
        <path d={`${path(main.map((p) => ({ pct: p.pct, v: p.near })))} L${x(s.maxPct)},${y(0)} L${x(0)},${y(0)} Z`} fill="rgba(255,77,77,0.10)" />
        <path d={path(main.map((p) => ({ pct: p.pct, v: p.near })))} fill="none" stroke="var(--red)" strokeWidth="2" />
        <path d={path(main.map((p) => ({ pct: p.pct, v: p.liquidatable })))} fill="none" stroke="#a11d1d" strokeWidth="1.5" strokeDasharray="4 3" />
        {tydro ? <path d={path(tydro.map((p) => ({ pct: p.pct, v: p.near })))} fill="none" stroke="var(--slate)" strokeWidth="1.2" /> : null}
        {nado ? <path d={path(nado.map((p) => ({ pct: p.pct, v: p.near })))} fill="none" stroke="var(--violet)" strokeWidth="1.2" /> : null}
        <line x1={x(q.pct)} x2={x(q.pct)} y1={T} y2={H - B} stroke="var(--ink)" strokeWidth="1" strokeDasharray="2 3" />
        <circle cx={x(q.pct)} cy={y(main[q.pct]?.near ?? 0)} r="3.5" fill="var(--red)" />
      </svg>
      <div className="pm-legend mono">
        <span><i style={{ background: 'var(--red)' }} />near liquidation (or worse)</span>
        <span><i style={{ background: '#a11d1d' }} />liquidatable</span>
        {tydro ? <span><i style={{ background: 'var(--slate)' }} />Tydro-only wallets</span> : null}
        {nado ? <span><i style={{ background: 'var(--violet)' }} />Nado-only wallets</span> : null}
      </div>
      <details className="pm-table">
        <summary>Table</summary>
        <table className="t">
          <thead>
            <tr><th>Move</th><th>Near liquidation</th><th>Liquidatable</th>{tydro ? <th>Tydro only</th> : null}{nado ? <th>Nado only</th> : null}</tr>
          </thead>
          <tbody>
            {main.filter((p) => p.pct % 5 === 0).map((p) => (
              <tr key={p.pct}>
                <td className="mono">{sign}{p.pct}%</td>
                <td className="num">{p.near.toLocaleString('en-US')}</td>
                <td className="num">{p.liquidatable.toLocaleString('en-US')}</td>
                {tydro ? <td className="num">{tydro[p.pct]!.near.toLocaleString('en-US')}</td> : null}
                {nado ? <td className="num">{nado[p.pct]!.near.toLocaleString('en-US')}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function Families({ s, q, onPick }: { s: PressureSnapshot; q: PressureQuery; onPick: (dir: string) => void }) {
  const rows = DIRECTIONS.filter((d) => !(q.sign === 'up' && d.downOnly)).map((d) => ({ d, r: queryPressure(s, { ...q, dir: d.id, sign: d.downOnly ? 'down' : q.sign }) }));
  const max = Math.max(1, ...rows.map((x) => x.r.affected));
  const top = rows.reduce((a, b) => (b.r.affected > a.r.affected ? b : a), rows[0]!);
  return (
    <div>
      <div className="faint pm-sub">Wallets pushed closer to liquidation if each one {q.sign === 'down' ? 'falls' : 'rises'} {q.pct}% on its own (depegs fall).</div>
      <ul className="pm-bars">
        {rows.map(({ d, r }) => (
          <li key={d.id}>
            <button type="button" className={`pm-bar${d.id === q.dir ? ' on' : ''}`} onClick={() => onPick(d.id)} aria-label={`${d.label}: ${r.affected} wallets`}>
              <span className="pm-bar-l">{d.label}</span>
              <span className="pm-bar-t"><i style={{ width: `${(r.affected / max) * 100}%` }} /></span>
              <b className="num">{r.affected.toLocaleString('en-US')}</b>
            </button>
          </li>
        ))}
      </ul>
      {top.r.affected > 0 ? <div className="mono faint">Most exposed: {top.d.label}.</div> : null}
    </div>
  );
}

function Bands({ s, q }: { s: PressureSnapshot; q: PressureQuery }) {
  const at = (m: Material) => queryPressure(s, { ...q, material: m });
  const [a0, a1, a10, a100] = (['0', '1k', '10k', '100k'] as const).map(at) as [ReturnType<typeof at>, ReturnType<typeof at>, ReturnType<typeof at>, ReturnType<typeof at>];
  const rows = [
    { label: 'Under $1,000', aff: a0.affected - a1.affected, pop: a0.population - a1.population },
    { label: '$1,000–$10,000', aff: a1.affected - a10.affected, pop: a1.population - a10.population },
    { label: '$10,000–$100,000', aff: a10.affected - a100.affected, pop: a10.population - a100.population },
    { label: '$100,000+', aff: a100.affected, pop: a100.population },
  ];
  const max = Math.max(1, ...rows.map((r) => r.aff));
  return (
    <div>
      <div className="faint pm-sub">Wallets pushed closer to liquidation, by wallet size (the same size bands the well uses).</div>
      <ul className="pm-bars">
        {rows.map((r) => (
          <li key={r.label} className="pm-bar static">
            <span className="pm-bar-l">{r.label}</span>
            <span className="pm-bar-t"><i style={{ width: `${(r.aff / max) * 100}%` }} /></span>
            <b className="num">{r.aff.toLocaleString('en-US')}</b>
            <span className="faint num pm-of">of {r.pop.toLocaleString('en-US')}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Breakdown({ s, q, rows }: { s: PressureSnapshot; q: PressureQuery; rows: Array<{ v: string; label: string }> }) {
  const data = rows.map((x) => ({ ...x, r: queryPressure(s, { ...q, dim: x.v }) })).filter((x) => x.r.population > 0);
  const max = Math.max(1, ...data.map((x) => x.r.affected));
  if (!data.length) return <div className="dim">No wallets with debt or perps in this selection.</div>;
  return (
    <ul className="pm-bars">
      {data.map((x) => (
        <li key={x.v} className="pm-bar static">
          <span className="pm-bar-l">{x.label.replace(/^Type: /, '')}</span>
          <span className="pm-bar-t"><i style={{ width: `${(x.r.affected / max) * 100}%` }} /></span>
          <b className="num">{x.r.affected.toLocaleString('en-US')}</b>
          <span className="faint num pm-of">of {x.r.population.toLocaleString('en-US')}</span>
        </li>
      ))}
    </ul>
  );
}

function ShareBox({ s, q, stress }: { s: PressureSnapshot; q: PressureQuery; stress: StressReading }) {
  const [copied, setCopied] = useState(false);
  const url = typeof window === 'undefined' ? '' : `${window.location.origin}/pressure?d=${q.dir}&s=${q.sign}&p=${q.pct}&m=${q.material}&by=${encodeURIComponent(q.dim)}`;
  const text = shareText(s, q, stress, url, Date.now());
  return (
    <Panel title="Share this scenario" rail="var(--amber)" testId="pressure-share">
      <pre className="pm-share mono" data-testid="pressure-share-text">{text}</pre>
      <button
        type="button"
        className="pill-btn"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => setCopied(true));
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <span className="faint pm-sub"> Counts and labels only — no balances, no wallets.</span>
    </Panel>
  );
}
