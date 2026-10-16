/**
 * INTEL — history and ecosystem intelligence. One top-level section, with tabs:
 *   HISTORY       ecosystem risk over time (Flight Recorder aggregates) — built
 *   LIQUIDATIONS  the liquidation ledger (Release 2)
 *   ORACLES       Oracle Watch (Release 3)
 *   CHANGES       Protocol Change Monitor (Release 3)
 *   CARRY         Yield and Carry (Release 4) — analysis only
 *   DEPTH         Nado order books: spread, depth near the price, Nado vs oracle (depth-1.0.0)
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MATERIAL, MATERIAL_LABEL, type AggPoint, type DataGap, type Material } from '@aegis/census';
import { NO_TYPE_LABEL, TAG_LABEL, primaryTypeLabel } from '@aegis/glyphs';
import type { Tag } from '@aegis/pose';
import { Panel } from '../components/bits';
import { LiquidationsPanel } from '../components/Liquidations';
import { OraclesPanel } from '../components/Oracles';
import { ChangesPanel } from '../components/Changes';
import { CarryPanel } from '../components/Carry';
import { DepthPanel } from '../components/Depth';
import { CountChart, RangePicker, RiskStrip, ScanGaps, when } from '../components/HistoryBits';
import { WELL_ON } from '../lib/census';
import { useAggHistory, useHistoryIndex, type Range } from '../lib/history';

const TABS = [
  ['history', 'HISTORY'],
  ['liquidations', 'LIQUIDATIONS'],
  ['oracles', 'ORACLES'],
  ['changes', 'CHANGES'],
  ['carry', 'CARRY'],
  ['depth', 'DEPTH'],
] as const;
type Tab = (typeof TABS)[number][0];

export function IntelPage() {
  const [params, setParams] = useSearchParams();
  const t = params.get('tab');
  const tab: Tab = TABS.some(([k]) => k === t) ? (t as Tab) : 'history';
  return (
    <div className="stack">
      <h2 className="page">Intel</h2>
      <div className="view-switch intel-tabs" role="tablist" aria-label="Intel sections" data-testid="intel-tabs">
        {TABS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={`sq-btn${tab === k ? ' on' : ''}`}
            onClick={() => setParams(k === 'history' ? {} : { tab: k }, { replace: true })}
            data-testid={`intel-tab-${k}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'history' ? (WELL_ON ? <EcosystemHistory /> : <div className="banner red">Locked with the well until the readings are verified against the official apps.</div>) : null}
      {tab === 'liquidations' ? (WELL_ON ? <LiquidationsPanel /> : <div className="banner red">Locked with the well until the readings are verified against the official apps.</div>) : null}
      {tab === 'oracles' ? <OraclesPanel /> : null}
      {tab === 'changes' ? <ChangesPanel /> : null}
      {tab === 'carry' ? <CarryPanel /> : null}
      {tab === 'depth' ? <DepthPanel /> : null}
    </div>
  );
}

const STRESS_COLOR: Record<string, string> = { CALM: 'var(--cyan)', ELEVATED: 'var(--amber)', HIGH: '#B8612A', CRITICAL: 'var(--red)' };
const MIX_KEYS = ['CARRY', 'EQUITY-MARGIN', 'NAKED', 'KBTC-CORE', 'LOCKED', 'STABLE-BALLAST', 'LEVERED', 'HOLD', 'WOUNDED', 'DARK', 'NONE'];
const FLOOR_SHORT: Record<Material, string> = { '0': 'ALL', '1k': '≥ $1K', '10k': '≥ $10K', '100k': '≥ $100K' };

function EcosystemHistory() {
  const idx = useHistoryIndex();
  const [range, setRange] = useState<Range>('7d');
  const [floor, setFloor] = useState<Material>('1k');
  const [showTable, setShowTable] = useState(false);
  const index = idx.status === 'ok' ? idx.index : null;
  const h = useAggHistory(range, index);

  return (
    <Panel title="Ecosystem history" rail="var(--violet)" testId="intel-history" right={<span className="mono">recorded live by the hourly scan</span>}>
      <div className="stack" style={{ gap: 12 }}>
        {idx.status === 'loading' ? <div className="dim" role="status">Loading the recorded history…</div> : null}
        {idx.status === 'error' ? <div className="banner red" role="alert">History couldn't be loaded ({idx.message}). Nothing is shown rather than a guess.</div> : null}
        {idx.status === 'none' ? (
          <div className="banner" data-testid="history-not-started">
            NOT RECORDING YET — the hourly scan starts the flight recorder once this version is deployed. Nothing before that is recorded, backfilled or made up.
          </div>
        ) : null}
        {index ? (
          <>
            <div className="faint mono" style={{ fontSize: 11 }}>
              Recording since {index.firstAt ? when(Date.parse(index.firstAt)) : '—'} (block {index.firstBlock?.toLocaleString('en-US') ?? '—'}). Counts of wallets — never balances. Points older than 90 days are thinned to one every 6 hours plus every change.
            </div>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <RangePicker value={range} onChange={setRange} testId="intel-range" />
              <div className="view-switch" role="group" aria-label="Wallet size floor" data-testid="intel-floor">
                {MATERIAL.map((m) => (
                  <button key={m} type="button" className={`sq-btn${floor === m ? ' on' : ''}`} aria-pressed={floor === m} onClick={() => setFloor(m)} title={MATERIAL_LABEL[m]}>
                    {FLOOR_SHORT[m]}
                  </button>
                ))}
              </div>
            </div>
            {h.status === 'loading' ? <div className="dim" role="status">Loading…</div> : null}
            {h.status === 'none' ? <div className="dim" data-testid="history-empty">Nothing recorded in this range yet.</div> : null}
            {h.status === 'error' ? <div className="banner red" role="alert">History couldn't be loaded ({h.message}).</div> : null}
            {h.status === 'ok' ? <Charts points={h.points} gaps={h.gaps} from={h.from} to={h.to} floor={floor} showTable={showTable} onTable={setShowTable} /> : null}
            <details className="hist-notyet">
              <summary className="mono dim">Not in this history yet</summary>
              <ul className="dim">
                <li>Actual liquidations: see the LIQUIDATIONS tab. Oracle prices and events: see ORACLES. Parameter changes: see CHANGES. Pressure forecast scoring: see CHECKS → Track record.</li>
                <li>Anything before recording began. Phrourax doesn't backfill risk it didn't observe.</li>
              </ul>
            </details>
          </>
        ) : null}
      </div>
    </Panel>
  );
}

function Charts({
  points,
  gaps,
  from,
  to,
  floor,
  showTable,
  onTable,
}: {
  points: AggPoint[];
  gaps: DataGap[];
  from: number;
  to: number;
  floor: Material;
  showTable: boolean;
  onTable: (b: boolean) => void;
}) {
  const t = (p: AggPoint) => Date.parse(p.at);
  const series = useMemo(
    () => [
      { name: 'Near liquidation', color: 'var(--red)', points: points.map((p) => ({ t: t(p), v: p.risk[floor][2] })) },
      { name: 'Watch', color: 'var(--amber)', points: points.map((p) => ({ t: t(p), v: p.risk[floor][1] })) },
      { name: "Couldn't read", color: 'var(--slate)', points: points.map((p) => ({ t: t(p), v: p.risk[floor][3] })) },
    ],
    [points, floor],
  );
  const stressPts = points.filter((p) => p.stress);
  const stressSpans = stressPts.map((p, i) => ({
    from: t(p),
    to: stressPts[i + 1] ? t(stressPts[i + 1]!) : to,
    color: STRESS_COLOR[p.stress!.level],
    text: `${when(t(p))} · ${p.stress!.level}${p.stress!.confidence === 'REDUCED' ? ' (reduced confidence)' : ''}`,
  }));
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const reorgs = points.filter((p) => p.reorg).length;
  const versions = [...new Set(points.map((p) => p.v.rules))];

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div>
        <div className="panel-title" style={{ marginBottom: 6 }}>Wallets by risk · {MATERIAL_LABEL[floor].toLowerCase()}</div>
        <CountChart series={series} from={from} to={to} gaps={gaps} label={`Wallet risk counts over time, ${MATERIAL_LABEL[floor]}`} />
        <div className="hist-axis mono faint"><span>{when(from)}</span><span>now</span></div>
        <div className="note-text">
          Now: <b>{last.risk[floor][2].toLocaleString('en-US')}</b> near liquidation, <b>{last.risk[floor][1].toLocaleString('en-US')}</b> watch, {last.risk[floor][0].toLocaleString('en-US')} safe,{' '}
          {last.risk[floor][3].toLocaleString('en-US')} couldn't be read · of {(last.risk[floor].reduce((a, b) => a + b, 0)).toLocaleString('en-US')} wallets {MATERIAL_LABEL[floor].toLowerCase()}.
        </div>
        <ScanGaps gaps={gaps} points={points} />
      </div>

      <div>
        <div className="panel-title" style={{ marginBottom: 6 }}>Ink Stress Level (measured on full scans)</div>
        {stressSpans.length ? (
          <>
            <RiskStrip spans={stressSpans} gaps={[]} from={from} to={to} label={`Ink Stress Level over time: ${stressSpans.map((s) => s.text).join('; ')}`} />
            <div className="hist-legend">
              {Object.entries(STRESS_COLOR).map(([k, c]) => (
                <span key={k}><i style={{ background: c }} />{k}</span>
              ))}
            </div>
          </>
        ) : (
          <div className="dim">Not measured in this range yet — the level is computed on full scans (every 3 hours).</div>
        )}
      </div>

      <div className="grid two">
        <div>
          <div className="panel-title" style={{ marginBottom: 6 }}>Position types · start of range → now</div>
          <div className="table-wrap"><table className="t" data-testid="intel-mix">
            <thead><tr><th>Type</th><th>{when(t(first)).slice(0, 10)}</th><th>Now</th></tr></thead>
            <tbody>
              {MIX_KEYS.filter((k) => first.mix[k] || last.mix[k]).map((k) => (
                <tr key={k}>
                  <td>{primaryTypeLabel(k as Tag | 'NONE')}</td>
                  <td className="num">{(first.mix[k] ?? 0).toLocaleString('en-US')}</td>
                  <td className="num">{(last.mix[k] ?? 0).toLocaleString('en-US')}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
        <div>
          <div className="panel-title" style={{ marginBottom: 6 }}>Venues · start of range → now</div>
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Venue</th><th>{when(t(first)).slice(0, 10)}</th><th>Now</th></tr></thead>
            <tbody>
              <tr><td>Tydro</td><td className="num">{first.venues.tydro.toLocaleString('en-US')}</td><td className="num">{last.venues.tydro.toLocaleString('en-US')}</td></tr>
              <tr><td>Nado</td><td className="num">{first.venues.nado.toLocaleString('en-US')}</td><td className="num">{last.venues.nado.toLocaleString('en-US')}</td></tr>
              <tr><td>Both</td><td className="num">{first.venues.both.toLocaleString('en-US')}</td><td className="num">{last.venues.both.toLocaleString('en-US')}</td></tr>
              <tr><td>With a position</td><td className="num">{first.drawn.toLocaleString('en-US')}</td><td className="num">{last.drawn.toLocaleString('en-US')}</td></tr>
            </tbody>
          </table></div>
        </div>
      </div>

      <div className="faint mono" style={{ fontSize: 11 }} data-testid="intel-provenance">
        {points.length.toLocaleString('en-US')} recorded points · rules {versions.join(', ')} · reader {last.v.reader} · engine {last.v.engine} · {gaps.length} data gap{gaps.length === 1 ? '' : 's'}
        {reorgs ? ` · ${reorgs} point(s) on reorganised blocks (kept, marked)` : ''}
      </div>

      <details open={showTable} onToggle={(e) => onTable((e.target as HTMLDetailsElement).open)}>
        <summary className="mono dim" style={{ fontSize: 11, cursor: 'pointer' }}>Table — every recorded point in this range ({points.length.toLocaleString('en-US')})</summary>
        {showTable ? (
          <div className="table-wrap" style={{ maxHeight: 420, overflow: 'auto' }}>
            <table className="t" data-testid="intel-table">
              <thead>
                <tr><th>When (UTC)</th><th>Block</th><th>Near liq.</th><th>Watch</th><th>Safe</th><th>Unreadable</th><th>Stress</th><th>Scan</th><th>Rules</th></tr>
              </thead>
              <tbody>
                {[...points].reverse().map((p) => (
                  <tr key={p.block}>
                    <td className="mono">{when(t(p))}</td>
                    <td className="mono">{p.block.toLocaleString('en-US')}{p.reorg ? ' (reorg)' : ''}</td>
                    <td className="num">{p.risk[floor][2]}</td>
                    <td className="num">{p.risk[floor][1]}</td>
                    <td className="num">{p.risk[floor][0]}</td>
                    <td className="num">{p.risk[floor][3]}</td>
                    <td className="mono">{p.stress ? p.stress.level : '—'}</td>
                    <td className="mono">{p.sweep === 'full' ? (p.complete ? 'full' : 'full · partial') : 'hourly'}</td>
                    <td className="mono">{p.v.rules}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </details>
    </div>
  );
}
