/**
 * CHECKS → Track record: AEGIS's own warnings scored against what actually happened (acct-1.0.0).
 * Every rate is shown with its numerator and denominator; small samples say so; versions are never pooled.
 */
import { FORECAST_SCORE, LEDGER, type Accountability, type Breakdown, type ForecastScore, type Rate } from '@aegis/census';
import { NO_TYPE_LABEL, SIZE_LABEL, TAG_LABEL } from '@aegis/glyphs';
import type { Tag } from '@aegis/pose';
import { Panel } from './bits';
import { when } from './HistoryBits';
import { useAccountability, useForecastScore } from '../lib/history';

export function RateCell({ r }: { r: Rate }) {
  if (!r.den) return <span className="faint">— (0 cases)</span>;
  return (
    <span>
      <b>{r.num}</b> of {r.den}
      {r.rate !== null ? <span className="faint"> ({(r.rate * 100).toFixed(0)}%)</span> : null}
      {r.lowSample ? <span className="faint" title={`fewer than ${LEDGER.MIN_SAMPLE} cases`}> · too few to judge</span> : null}
    </span>
  );
}

const keyLabel = (group: string, k: string) => {
  if (group === 'type') return (TAG_LABEL as Record<string, string>)[k as Tag] ?? (k === 'none' || k === 'none recorded' ? NO_TYPE_LABEL : k);
  if (group === 'size') return (SIZE_LABEL as Record<string, string>)[k] ?? k;
  return k;
};

function BreakdownTable({ title, rows, group }: { title: string; rows: Breakdown[]; group: string }) {
  if (!rows.length) return null;
  return (
    <div>
      <div className="panel-title" style={{ marginBottom: 6 }}>{title}</div>
      <div className="table-wrap">
        <table className="t">
          <thead><tr><th /><th>Liquidations warned NEAR before</th><th>Warnings followed within 24 h</th></tr></thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.key}>
                <td className="mono">{keyLabel(group, b.key)}</td>
                <td><RateCell r={b.recall} /></td>
                <td><RateCell r={b.precision24} /></td>
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
    <Panel title="Track record — were AEGIS's warnings right?" rail="var(--violet)" testId="track-record" right={<span className="mono">{LEDGER.ACCOUNT_VERSION}</span>}>
      {s.status === 'loading' ? <div className="dim" role="status">Loading…</div> : null}
      {s.status === 'error' ? <div className="banner red" role="alert">Couldn't load ({s.message}). Nothing is shown rather than a guess.</div> : null}
      {s.status === 'none' ? (
        <div className="banner" data-testid="track-not-started">
          NOT SCORED YET — the hourly scan starts recording AEGIS's warnings and real liquidations after this update. Scores appear as both build up; until then there is nothing honest to show.
        </div>
      ) : null}
      {s.status === 'ok' ? <Scores a={s.a} /> : null}
    </Panel>
  );
}

function Scores({ a }: { a: Accountability }) {
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="faint" style={{ fontSize: 12 }}>
        AEGIS uses fixed, published rules — no model is trained or tuned on this. Scored {when(Date.parse(a.generatedAt))} · recording since {a.recordingStart ? when(Date.parse(a.recordingStart)) : '—'}.
      </div>
      <dl className="kv" data-testid="track-headline">
        <dt>Liquidations it could judge</dt>
        <dd>
          <b>{a.liquidations.evaluable}</b> of {a.liquidations.total} recorded ({a.liquidations.beforeRecording} happened before recording began and are left out of every rate; {a.liquidations.partial} with a field unavailable)
        </dd>
        <dt>Had NEAR LIQUIDATION before</dt>
        <dd><RateCell r={a.recall} /></dd>
        <dt>Only WATCH before</dt>
        <dd><RateCell r={a.watchOnly} /></dd>
        <dt>No warning (missed)</dt>
        <dd>
          <RateCell r={a.missed} />
          {a.liquidations.notSeen ? <span className="faint"> · {a.liquidations.notSeen} of all judged were wallets AEGIS had never seen</span> : null}
        </dd>
        <dt>Median warning lead</dt>
        <dd>{a.leadHoursMedian === null ? '—' : `${a.leadHoursMedian.toFixed(1)} h`}</dd>
        <dt>Warnings recorded</dt>
        <dd>{a.warnings.total} ({a.warnings.atRecordingStart} already near when recording began)</dd>
      </dl>

      <div>
        <div className="panel-title" style={{ marginBottom: 6 }}>By time window</div>
        <div className="table-wrap">
          <table className="t" data-testid="track-windows">
            <thead><tr><th>Window</th><th>Warnings followed by that wallet's liquidation</th><th>Not judged yet</th><th>Liquidations warned at least this long before</th></tr></thead>
            <tbody>
              {a.windows.map((w) => (
                <tr key={w.hours}>
                  <td className="mono">{w.hours < 24 ? `${w.hours} h` : w.hours === 24 ? '1 day' : `${w.hours / 24} days`}</td>
                  <td><RateCell r={w.precision} /></td>
                  <td className="num">{w.pending}</td>
                  <td><RateCell r={w.leadAtLeast} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
          A warning not followed by a liquidation isn't necessarily wrong — the owner may have added collateral. A false-alarm rate here would overstate that, so it's shown as counts.
        </div>
      </div>

      <div className="grid two">
        <BreakdownTable title="By venue" rows={a.byVenue} group="venue" />
        <BreakdownTable title="By size range" rows={a.bySize} group="size" />
        <BreakdownTable title="By position type (at the time)" rows={a.byType} group="type" />
        <BreakdownTable title="By rules version — never pooled" rows={a.byRules} group="rules" />
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
          NOT SCORED YET — forecasts can only be checked against prices AEGIS recorded, and price recording starts with Oracle Watch. Scores appear once a forecast&apos;s 24 hours have passed with prices recorded throughout.
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
