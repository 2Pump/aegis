/**
 * Flight Recorder pieces shared by the wallet HISTORY panel and INTEL → HISTORY. Every chart has a table
 * alternative; gaps are drawn as gaps (hatched), never joined up.
 */
import type { HullTemp } from '@aegis/pose';
import { RISK_LABEL } from '@aegis/glyphs';
import { RANGES, type Range } from '../lib/history';

export const RISK_COLOR: Record<HullTemp, string> = { NOMINAL: '#3b8f88', ELEVATED: 'var(--amber)', CRITICAL: 'var(--red)', UNKNOWN: 'var(--slate)' };

export const when = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

export function RangePicker({ value, onChange, testId }: { value: Range; onChange: (r: Range) => void; testId?: string }) {
  return (
    <div className="view-switch" role="group" aria-label="Time range" data-testid={testId}>
      {RANGES.map(([r, label]) => (
        <button key={r} type="button" className={`sq-btn${value === r ? ' on' : ''}`} aria-pressed={value === r} onClick={() => onChange(r)} data-testid={`range-${r}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

const W = 1000;

/** A horizontal strip: one coloured span per recorded state, hatched where no scan ran. */
export function RiskStrip({
  spans,
  gaps,
  from,
  to,
  label,
}: {
  spans: Array<{ from: number; to: number; hull?: HullTemp; color?: string; text: string }>;
  gaps: Array<{ from: number; to: number }>;
  from: number;
  to: number;
  label: string;
}) {
  const x = (t: number) => ((Math.min(Math.max(t, from), to) - from) / Math.max(1, to - from)) * W;
  return (
    <svg className="hist-strip" viewBox={`0 0 ${W} 28`} preserveAspectRatio="none" role="img" aria-label={label}>
      <defs>
        <pattern id="hist-gap" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="#05080c" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="#4f5a68" strokeWidth="2" />
        </pattern>
      </defs>
      <rect x="0" y="0" width={W} height="28" fill="#05080c" />
      {spans.map((s, i) => (
        <rect key={i} x={x(s.from)} y="4" width={Math.max(1, x(s.to) - x(s.from))} height="20" fill={s.color ?? RISK_COLOR[s.hull ?? 'UNKNOWN']}>
          <title>{s.text}</title>
        </rect>
      ))}
      {gaps.map((g, i) => (
        <rect key={`g${i}`} x={x(g.from)} y="0" width={Math.max(1, x(g.to) - x(g.from))} height="28" fill="url(#hist-gap)">
          <title>No scan between {when(g.from)} and {when(g.to)}</title>
        </rect>
      ))}
    </svg>
  );
}

/** Lines over time (counts). Breaks the line across gaps instead of drawing through them. */
export function CountChart({
  series,
  from,
  to,
  gaps,
  label,
  height = 160,
}: {
  series: Array<{ name: string; color: string; points: Array<{ t: number; v: number }> }>;
  from: number;
  to: number;
  gaps: Array<{ from: number; to: number }>;
  label: string;
  height?: number;
}) {
  const max = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.v)));
  const H = height;
  const x = (t: number) => ((t - from) / Math.max(1, to - from)) * W;
  const y = (v: number) => H - 14 - (v / max) * (H - 24);
  // a gap lying between two points breaks the line there
  const inGap = (a: number, b: number) => gaps.some((g) => g.from >= a && g.to <= b);
  const path = (pts: Array<{ t: number; v: number }>) => {
    let d = '';
    pts.forEach((p, i) => {
      const prev = pts[i - 1];
      d += `${!prev || inGap(prev.t, p.t) ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)} `;
    });
    return d;
  };
  return (
    <div>
      <svg className="hist-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} style={{ height: H }}>
        <rect x="0" y="0" width={W} height={H} fill="#05080c" />
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1="0" x2={W} y1={y(max * f)} y2={y(max * f)} stroke="rgba(160,170,180,0.08)" />
        ))}
        {gaps.map((g, i) => (
          <rect key={i} x={x(g.from)} y="0" width={Math.max(1, x(g.to) - x(g.from))} height={H} fill="rgba(79,90,104,0.18)">
            <title>No scan between {when(g.from)} and {when(g.to)}</title>
          </rect>
        ))}
        {series.map((s) => (
          <path key={s.name} d={path(s.points)} fill="none" stroke={s.color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        ))}
        {/* with only one or two recorded points a line says nothing: show the points themselves */}
        {series.map((s) =>
          s.points.length <= 2
            ? s.points.map((p) => <rect key={`${s.name}${p.t}`} x={Math.min(W - 8, Math.max(0, x(p.t) - 4))} y={y(p.v) - 4} width="8" height="8" fill={s.color} />)
            : null,
        )}
        <text x="4" y="12" fill="#7d8b9b" fontSize="11" fontFamily="IBM Plex Mono, monospace">{max.toLocaleString('en-US')}</text>
      </svg>
      <div className="hist-legend">
        {series.map((s) => (
          <span key={s.name}>
            <i style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
        {gaps.length ? (
          <span>
            <i className="gap" />
            no scan ({gaps.length})
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function RiskLegend() {
  return (
    <div className="hist-legend">
      {(['NOMINAL', 'ELEVATED', 'CRITICAL', 'UNKNOWN'] as HullTemp[]).map((h) => (
        <span key={h}>
          <i style={{ background: RISK_COLOR[h] }} />
          {RISK_LABEL[h]}
        </span>
      ))}
      <span>
        <i className="gap" />
        no scan
      </span>
    </div>
  );
}
