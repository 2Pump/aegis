/**
 * CHECKS → Track record: Phrourax's own warnings scored against what actually happened (acct-1.1.0).
 * Baseline risk states (already NEAR when recording began) are shown on their own row and never scored as warnings.
 * Every rate is shown with its numerator and denominator; small samples say so; versions are never pooled.
 */
import { FORECAST_SCORE, LEDGER, type Accountability, type Breakdown, type ForecastScore, type Rate } from '@aegis/census';
import { NO_TYPE_LABEL, SIZE_LABEL, TAG_LABEL } from '@aegis/glyphs';
import type { Tag } from '@aegis/pose';
import { Panel } from './bits';
import { when } from './HistoryBits';
import { useAccountability, useForecastScore } from '../lib/history';

/** A share that never rounds a real non-zero count to "0%". */
export function pctText(rate: number): string {
  const p = rate * 100;
  if (p === 0) return '0%';
  if (p < 0.1) return '<0.1%';
  if (p < 10) return `${p.toFixed(1)}%`;
  return `${p.toFixed(0)}%`;
}

export function RateCell({ r }: { r: Rate }) {
  if (!r.den) return <span className="faint">— (0 cases)</span>;
  return (
    <span>
      <b>{r.num.toLocaleString('en-US')}</b> of {r.den.toLocaleString('en-US')}
      {r.rate !== null ? <span className="faint"> ({pctText(r.rate)})</span> : null}
      {r.lowSample ? <span className="faint" title={`fewer than ${LEDGER.MIN_SAMPLE} cases`}> · too few to judge</span> : null}
    </span>
  );
}

const keyLabel = (group: string, k: string) => {
  if (group === 'type') return (TAG_LABEL as Record<string, string>)[k as Tag] ?? (k === 'none' || k === 'none recorded' ? NO_TYPE_LABEL : k);
  if (group === 'size') return (SIZE_LABEL as Record<string, string>)[k] ?? k;
  return k;
};

/** Shown instead of a warning rate from a score file made under the old method (baseline rows were in the denominators). */
function Unscored() {
  return <span className="faint" title="This score file still counts baseline risk states as warnings. The next hourly run republishes it without them.">unavailable — rescored on the next hourly run</span>;
}

function BreakdownTable({ title, rows, group, legacy }: { title: string; rows: Breakdown[]; group: string; legacy: boolean }) {
  if (!rows.length) return null;
  return (
    <div>
      <div className="panel-title" style={{ marginBottom: 6 }}>{title}</div>
      <div className="table-wrap">
        <table className="t">
          <thead><tr><th /><th>Liquidations warned NEAR before</th><th>New warnings followed within 24 h</th></tr></thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.key}>
                <td className="mono">{keyLabel(group, b.key)}</td>
                <td><RateCell r={b.recall} /></td>
                <td>{legacy ? <Unscored /> : <RateCell r={b.precision24} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function TrackRecord() {
  const s = useAccountability();
  return (
    <Panel title="Track record — were Phrourax's warnings right?" rail="var(--violet)" testId="track-record" right={<span className="mono">{LEDGER.ACCOUNT_VERSION}</span>}>
      {s.status === 'loading' ? <div className="dim" role="status">Loading…</div> : null}
      {s.status === 'error' ? <div className="banner red" role="alert">Couldn't load ({s.message}). Nothing is shown rather than a guess.</div> : null}
      {s.status === 'none' ? (
        <div className="banner" data-testid="track-not-started">
          NOT SCORED YET — the hourly scan starts recording Phrourax's warnings and real liquidations after this update. Scores appear as both build up; until then there is nothing honest to show.
        </div>
      ) : null}
      {s.status === 'ok' ? <Scores a={s.a} /> : null}
    </Panel>
  );
}

function Scores({ a }: { a: Accountability }) {
  // a score file published before acct-1.1.0 counted baseline states as warnings: its warning rates aren't shown
  const legacy = a.version !== LEDGER.ACCOUNT_VERSION;
  const baseline = a.warnings.atRecordingStart;
  const fresh = a.warnings.afterRecordingStart ?? a.warnings.total - a.warnings.atRecordingStart;
  const judged24 = a.windows.find((w) => w.hours === 24)?.precision.den ?? 0;
  const early = a.recall.den < LEDGER.MIN_SAMPLE || legacy || judged24 < LEDGER.MIN_SAMPLE;
  const n = (x: number) => x.toLocaleString('en-US');
  return (
    <div className="stack" style={{ gap: 14 }}>
      {early ? (
        <div className="banner" data-testid="track-early" role="status">
          EARLY RECORDING PERIOD — performance statistics are not yet representative. Rates appear with their counts; under {LEDGER.MIN_SAMPLE} cases each is marked &ldquo;too few to judge&rdquo;.
        </div>
      ) : null}
      <div className="note-text">
        Phrourax uses fixed, published rules — no model is trained or tuned on this. Scored {when(Date.parse(a.generatedAt))} · recording since {a.recordingStart ? when(Date.parse(a.recordingStart)) : '—'} · method {a.version}.
      </div>

      <div className="grid two">
        <div>
          <div className="panel-title" style={{ marginBottom: 6 }}>Liquidation records</div>
          <dl className="kv" data-testid="track-liquidations">
            <dt>Total liquidation records</dt>
            <dd className="num">{n(a.liquidations.total)}</dd>
            <dt>Before Phrourax recording began</dt>
            <dd className="num">{n(a.liquidations.beforeRecording)} <span className="faint">— left out of every rate</span></dd>
            <dt>Evaluable since recording began</dt>
            <dd className="num">{n(a.liquidations.evaluable)}</dd>
            <dt>Records with one or more unavailable fields</dt>
            <dd className="num">{n(a.liquidations.partial)} <span className="faint">— across all records; overlaps the rows above</span></dd>
          </dl>
          <div className="note-text" style={{ marginTop: 4 }}>Before + evaluable = total. A record with an unavailable field (e.g. a size that couldn&apos;t be priced) can be in either group.</div>
        </div>
        <div>
          <div className="panel-title" style={{ marginBottom: 6 }}>Risk states recorded</div>
          <dl className="kv" data-testid="track-headline">
            <dt>Baseline risk states imported at recording start</dt>
            <dd className="num" data-testid="track-baseline">{n(baseline)} <span className="faint">— not warnings; never scored</span></dd>
            <dt>New warnings after recording began</dt>
            <dd className="num" data-testid="track-new-warnings">{n(fresh)} <span className="faint">— wallets that entered NEAR LIQUIDATION</span></dd>
          </dl>
          <div className="note-text" style={{ marginTop: 4 }}>A baseline state is what the first recorded scan found already near liquidation — Phrourax didn&apos;t predict it, so it isn&apos;t counted as a warning.</div>
        </div>
      </div>

      <div>
        <div className="panel-title" style={{ marginBottom: 6 }}>Evaluable liquidations — what Phrourax had recorded before</div>
        <dl className="kv">
          <dt>Had NEAR LIQUIDATION before</dt>
          <dd><RateCell r={a.recall} /></dd>
          <dt>Only WATCH before</dt>
          <dd><RateCell r={a.watchOnly} /></dd>
          <dt>No warning (missed)</dt>
          <dd>
            <RateCell r={a.missed} />
            {a.liquidations.notSeen ? <span className="faint"> · {n(a.liquidations.notSeen)} were wallets Phrourax had never seen</span> : null}
          </dd>
          <dt>Median warning lead</dt>
          <dd>{a.leadHoursMedian === null ? '—' : `${a.leadHoursMedian.toFixed(1)} h`}</dd>
        </dl>
      </div>

      <div>
        <div className="panel-title" style={{ marginBottom: 6 }}>By time window</div>
        <div className="table-wrap">
          <table className="t" data-testid="track-windows">
            <thead><tr><th>Window</th><th>New warnings followed by that wallet's liquidation</th><th>Not judged yet</th><th>Liquidations warned at least this long before</th></tr></thead>
            <tbody>
              {a.windows.map((w) => (
                <tr key={w.hours}>
                  <td className="mono">{w.hours < 24 ? `${w.hours} h` : w.hours === 24 ? '1 day' : `${w.hours / 24} days`}</td>
                  <td>{legacy ? <Unscored /> : <RateCell r={w.precision} />}</td>
                  <td className="num">{legacy ? '—' : n(w.pending)}</td>
                  <td><RateCell r={w.leadAtLeast} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="note-text" style={{ marginTop: 4 }}>
          Only new warnings (after recording began) are scored here. A warning not followed by a liquidation isn't necessarily wrong — the owner may have added collateral. A false-alarm rate here would overstate that, so it's shown as counts.
        </div>
      </div>

      <div className="grid two">
        <BreakdownTable title="By venue" legacy={legacy} rows={a.byVenue} group="venue" />
        <BreakdownTable title="By size range" legacy={legacy} rows={a.bySize} group="size" />
        <BreakdownTable title="By position type (at the time)" legacy={legacy} rows={a.byType} group="type" />
        <BreakdownTable title="By rules version — never pooled" legacy={legacy} rows={a.byRules} group="rules" />
      </div>
      {a.byFamily.length ? (
        <div>
          <div className="panel-title" style={{ marginBottom: 6 }}>By asset family (liquidations)</div>
          <div className="table-wrap">
            <table className="t">
              <tbody>
                {a.byFamily.map((f) => (
                  <tr key={f.key}><td className="mono">{f.key}</td><td><RateCell r={f.recall} /></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <details>
        <summary className="mono dim" style={{ fontSize: 11, cursor: 'pointer' }}>Definitions and limitations</summary>
        <dl className="kv tight" style={{ marginTop: 8 }}>
          {Object.entries(a.definitions).map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <ul className="dim" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
          {a.limitations.map((l) => <li key={l}>{l}</li>)}
        </ul>
      </details>
    </div>
  );
}

/** Pressure forecasts scored against recorded prices (forecast-score-1.0.0). */
export function ForecastTrack() {
  const s = useForecastScore();
  return (
    <Panel title="Pressure forecasts — did the scenarios happen?" rail="var(--violet)" testId="forecast-track" right={<span className="mono">{FORECAST_SCORE.VERSION}</span>}>
      {s.status === 'loading' ? <div className="dim" role="status">Loading…</div> : null}
      {s.status === 'error' ? <div className="banner red" role="alert">Couldn&apos;t load ({s.message}). Nothing is shown rather than a guess.</div> : null}
      {s.status === 'none' ? (
        <div className="banner" data-testid="forecast-not-started">
          NOT SCORED YET — forecasts can only be checked against prices Phrourax recorded, and price recording starts with Oracle Watch. Scores appear once a forecast&apos;s 24 hours have passed with prices recorded throughout.
        </div>
      ) : null}
      {s.status === 'ok' ? <ForecastBody f={s.v} /> : null}
    </Panel>
  );
}

function ForecastBody({ f }: { f: ForecastScore }) {
  const judged = f.scenarios.reduce((a, x) => a + x.judged, 0);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="faint mono" style={{ fontSize: 11 }} data-testid="forecast-counts">
        {f.forecasts.toLocaleString('en-US')} forecasts recorded · {f.pending} still inside their {f.horizonH} h window · {f.unjudgeable} can&apos;t be judged (made before prices were recorded, or a gap in the prices) · scored {when(Date.parse(f.generatedAt))}
      </div>
      {!judged ? (
        <div className="dim">No forecast has been judged yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="t" data-testid="forecast-table">
            <thead><tr><th>Scenario</th><th>Judged</th><th>Move happened within {f.horizonH} h</th><th>When it did: predicted near · most recorded near · liquidations seen</th></tr></thead>
            <tbody>
              {f.scenarios.map((x) => (
                <tr key={x.key}>
                  <td className="mono">{x.key}</td>
                  <td className="num">{x.judged}</td>
                  <td className="num">{x.reached}</td>
                  <td className="wrap-text" style={{ fontSize: 12 }}>
                    {x.comparisons.length
                      ? x.comparisons.slice(-3).map((c) => `${c.at.slice(0, 16).replace('T', ' ')}: ${c.predictedNear} · ${c.observedNear ?? '—'} · ${c.liquidationsSeen}`).join('; ')
                      : <span className="faint">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ul className="dim" style={{ fontSize: 12.5, lineHeight: 1.55, margin: 0 }}>
        {f.notes.map((n) => <li key={n}>{n}</li>)}
      </ul>
    </div>
  );
}
