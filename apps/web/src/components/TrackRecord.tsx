/**
 * CHECKS → Track record: Phrourax's own warnings scored against what actually happened.
 * One version concept: the SCORING METHOD (LEDGER.ACCOUNT_VERSION). The page shows the method the report on screen was
 * scored under; if the site has a newer method, it says so and marks the figures that changed as awaiting rescoring.
 * Every window has its own eligible denominator; "not enough recording history" and "awaiting outcome" are never zeros.
 */
import { FORECAST_SCORE, LEDGER, type Accountability, type Breakdown, type ForecastScore, type Rate, type WindowScore } from '@aegis/census';
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

const n = (x: number) => x.toLocaleString('en-US');

/** n of N, with a percentage only when there are enough cases to mean something. */
export function RateCell({ r, unit = '' }: { r: Rate; unit?: string }) {
  if (!r.den) return <span className="faint">— (0 cases)</span>;
  return (
    <span>
      <b>{n(r.num)}</b> of {n(r.den)}
      {unit ? ` ${unit}` : ''}
      {r.rate !== null && !r.lowSample ? <span className="faint"> ({pctText(r.rate)})</span> : null}
      {r.lowSample ? <span className="faint" title={`fewer than ${LEDGER.MIN_SAMPLE} cases`}> · too few cases to judge</span> : null}
    </span>
  );
}

const keyLabel = (group: string, k: string) => {
  if (group === 'type') return (TAG_LABEL as Record<string, string>)[k as Tag] ?? (k === 'none' || k === 'none recorded' ? NO_TYPE_LABEL : k);
  if (group === 'size') return (SIZE_LABEL as Record<string, string>)[k] ?? k;
  return k;
};
const windowLabel = (h: number) => (h < 24 ? `${h} h` : h === 24 ? '24 h' : `${h / 24} days`);

/** Shown instead of a figure from a report scored under an older method, where that figure was defined differently. */
function Rescoring() {
  return <span className="faint" data-testid="awaiting-rescoring">awaiting rescoring</span>;
}

function BreakdownTable({ title, rows, group, forward }: { title: string; rows: Breakdown[]; group: string; forward: 'ok' | 'rescoring' | 'unavailable' }) {
  if (!rows.length) return null;
  return (
    <div>
      <div className="panel-title" style={{ marginBottom: 6 }}>{title}</div>
      <div className="table-wrap">
        <table className="t">
          <thead><tr><th /><th>Liquidations with NEAR recorded before</th><th>New warnings followed within 24 h</th></tr></thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.key}>
                <td className="mono">{keyLabel(group, b.key)}</td>
                <td><RateCell r={b.recall} /></td>
                <td>{forward === 'rescoring' ? <Rescoring /> : forward === 'unavailable' ? <span className="faint">not available yet</span> : <RateCell r={b.precision24} />}</td>
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
  const shown = s.status === 'ok' ? s.a.version : LEDGER.ACCOUNT_VERSION;
  return (
    <Panel
      title="Track record — were Phrourax's warnings right?"
      rail="var(--violet)"
      testId="track-record"
      right={<span className="mono" data-testid="track-version" title="The scoring method: how warnings and liquidations are counted and judged. It is versioned so results under different methods are never pooled.">scoring method {shown}</span>}
    >
      {s.status === 'loading' ? <div className="dim" role="status">Loading…</div> : null}
      {s.status === 'error' ? <div className="banner red" role="alert">Couldn&apos;t load ({s.message}). Nothing is shown rather than a guess.</div> : null}
      {s.status === 'none' ? (
        <div className="banner" data-testid="track-not-started">
          NOT SCORED YET — the hourly scan starts recording Phrourax&apos;s warnings and real liquidations after this update. Scores appear as both build up; until then there is nothing honest to show.
        </div>
      ) : null}
      {s.status === 'ok' ? <Scores a={s.a} /> : null}
    </Panel>
  );
}

function BackwardCell({ w }: { w: WindowScore }) {
  if (!w.leadAtLeast.den) return <span className="faint">Not enough recording history</span>;
  return <RateCell r={w.leadAtLeast} unit="eligible liquidations" />;
}

function Scores({ a }: { a: Accountability }) {
  const current = a.version === LEDGER.ACCOUNT_VERSION;
  const tr = current ? a.transitions : undefined;
  const bl = current ? a.baseline : undefined;
  const forward: 'ok' | 'rescoring' | 'unavailable' = !current ? 'rescoring' : tr && !tr.available ? 'unavailable' : 'ok';
  const judged24 = a.windows.find((w) => w.hours === 24)?.precision.den ?? 0;
  const early = !current || a.recall.den < LEDGER.MIN_SAMPLE || judged24 < LEDGER.MIN_SAMPLE;
  return (
    <div className="stack" style={{ gap: 14 }}>
      {early ? (
        <div className="banner" data-testid="track-early" role="status">
          EARLY RECORDING PERIOD — performance statistics are not yet representative. Counts are shown as they are; under {LEDGER.MIN_SAMPLE} cases there is no percentage and the figure is marked &ldquo;too few cases to judge&rdquo;.
        </div>
      ) : null}
      {!current ? (
        <div className="census-explain amber" data-testid="track-method-note" role="status">
          <b>SCORED UNDER {a.version.toUpperCase()}</b> · This report was produced under scoring method {a.version}. The site now uses {LEDGER.ACCOUNT_VERSION}: each time window has its own eligible denominator, the baseline is counted as unique wallets, and new warnings are counted only from recorded transitions. The census republishes the report under {LEDGER.ACCOUNT_VERSION} on its next hourly run; until then the figures defined differently are shown as awaiting rescoring.
        </div>
      ) : null}
      <div className="note-text">
        Phrourax uses fixed, published rules — no model is trained or tuned on this. Scored {when(Date.parse(a.generatedAt))} · recording since {a.recordingStart ? when(Date.parse(a.recordingStart)) : '—'} · scoring method {a.version}.
      </div>

      <div className="grid two">
        <div>
          <div className="panel-title" style={{ marginBottom: 6 }}>Liquidation records</div>
          <dl className="kv stacked" data-testid="track-liquidations">
            <dt>Total liquidation records</dt>
            <dd className="num">{n(a.liquidations.total)}</dd>
            <dt>Before Phrourax recording began</dt>
            <dd className="num">{n(a.liquidations.beforeRecording)} <span className="faint">— left out of every figure below</span></dd>
            <dt>Evaluable since recording began</dt>
            <dd className="num">{n(a.liquidations.evaluable)}</dd>
            <dt>Records with one or more unavailable fields</dt>
            <dd className="num">{n(a.liquidations.partial)} <span className="faint">— across all records; overlaps the rows above</span></dd>
          </dl>
          <div className="note-text" style={{ marginTop: 4 }}>Before + evaluable = total. A record with an unavailable field (e.g. a size that couldn&apos;t be priced) can be in either group.</div>
        </div>
        <div>
          <div className="panel-title" style={{ marginBottom: 6 }}>Risk states recorded</div>
          <dl className="kv stacked" data-testid="track-headline">
            {bl ? (
              <>
                <dt>Unique wallets already NEAR LIQUIDATION at recording start</dt>
                <dd className="num" data-testid="track-baseline">{n(bl.uniqueWallets)} <span className="faint">— baseline; not scored</span></dd>
              </>
            ) : (
              <>
                <dt>Baseline rows imported (not a wallet count)</dt>
                <dd className="num" data-testid="track-baseline">{n(a.warnings.atRecordingStart)} <span className="faint">— baseline; not scored · unique wallets after rescoring</span></dd>
              </>
            )}
            <dt>New warnings after recording began</dt>
            <dd className="num" data-testid="track-new-warnings">
              {forward === 'ok' && tr ? (
                <>
                  {n(tr.counted)} <span className="faint">— entries into NEAR LIQUIDATION from a recorded lower state{tr.reliableSince ? `, since ${when(Date.parse(tr.reliableSince))}` : ''}</span>
                </>
              ) : (
                <span className="faint">New warning transitions not available yet</span>
              )}
            </dd>
          </dl>
          <div className="note-text" style={{ marginTop: 4 }} data-testid="track-baseline-explain">
            {bl ? (
              <>
                Counts each wallet once: the wallets in NEAR LIQUIDATION (WATCH is not included) in the first recorded scan{bl.firstAt ? `, ${when(Date.parse(bl.firstAt))}` : ''}.
                {bl.repeatedRows ? ` Before 2026-10-05 the "recording began" marker wasn't kept between runs, so ${n(bl.repeatedRuns)} later run(s) re-imported ${n(bl.repeatedRows)} baseline rows; those repeats are not wallets and are never counted (fixed).` : ''}{' '}
              </>
            ) : (
              <>
                This older report counts baseline <i>rows</i>: every wallet already near liquidation, once per run that imported a baseline — a wallet can appear many times, so the number can exceed the wallets the census covers.{' '}
              </>
            )}
            A baseline state is what the first recorded scan found already near liquidation — Phrourax didn&apos;t predict it, so it isn&apos;t counted as a warning.
            {forward === 'unavailable' ? ' New warnings are counted from a recorded lower state into NEAR; that count starts after the next complete hourly run.' : ''}
          </div>
        </div>
      </div>

      <div>
        <div className="panel-title" style={{ marginBottom: 6 }}>Evaluable liquidations — what Phrourax had recorded before</div>
        <dl className="kv">
          <dt>Had NEAR LIQUIDATION before</dt>
          <dd><RateCell r={a.recall} /></dd>
          <dt>Only WATCH before</dt>
          <dd><RateCell r={a.watchOnly} /></dd>
          <dt>No warning recorded</dt>
          <dd>
            <RateCell r={a.missed} />
            {a.liquidations.notSeen ? <span className="faint"> · {n(a.liquidations.notSeen)} were wallets Phrourax had never seen</span> : null}
          </dd>
          <dt>Median warning lead</dt>
          <dd>{a.leadHoursMedian === null ? '—' : `${a.leadHoursMedian.toFixed(1)} h`}</dd>
        </dl>
      </div>

      <div>
        <div className="panel-title" style={{ marginBottom: 6 }}>Looking back from each liquidation</div>
        <div className="table-wrap">
          <table className="t track-win" data-testid="track-lookback">
            <thead>
              <tr><th>Window</th><th>Had a NEAR warning at least this long before</th><th>No NEAR that long before</th><th>Not enough recording history</th></tr>
            </thead>
            <tbody>
              {a.windows.map((w) => (
                <tr key={w.hours}>
                  <td className="mono">{windowLabel(w.hours)}</td>
                  <td>{current ? <BackwardCell w={w} /> : <Rescoring />}</td>
                  <td className="num">{current && w.leadAtLeast.den ? n(w.leadAtLeast.den - w.leadAtLeast.num) : '—'}</td>
                  <td className="num">{current ? n(w.insufficientHistory ?? 0) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="note-text" style={{ marginTop: 4 }}>
          A liquidation is eligible for a window only if recording had begun at least that long before it — the time before recording began was not watched, so it can&apos;t count as a miss.
        </div>
      </div>

      <div>
        <div className="panel-title" style={{ marginBottom: 6 }}>Looking forward from each new warning</div>
        {forward === 'ok' ? (
          <div className="table-wrap">
            <table className="t track-win" data-testid="track-windows">
              <thead>
                <tr><th>Window</th><th>Followed by that wallet&apos;s liquidation</th><th>Not followed</th><th>Still awaiting outcome</th></tr>
              </thead>
              <tbody>
                {a.windows.map((w) => (
                  <tr key={w.hours}>
                    <td className="mono">{windowLabel(w.hours)}</td>
                    <td>
                      {w.precision.den ? (
                        <RateCell r={w.precision} unit="judged warnings" />
                      ) : (
                        <span className="faint">{w.pending ? 'No warnings have completed this window yet' : 'No new warnings yet'}</span>
                      )}
                    </td>
                    <td className="num">{w.precision.den ? n(w.precision.den - w.precision.num) : '—'}</td>
                    <td className="num">{n(w.pending)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="note-text" data-testid="track-windows">
            {forward === 'rescoring' ? (
              <>Awaiting rescoring under {LEDGER.ACCOUNT_VERSION} — this report&apos;s warning outcomes were counted differently.</>
            ) : (
              <>New warning transitions not available yet — counting starts after the next complete hourly run.</>
            )}
          </div>
        )}
        <div className="note-text" style={{ marginTop: 4 }}>
          Only new warnings are judged here (baseline states are not scored), and only once their whole window has passed; younger ones are awaiting outcome, never a miss. A warning not followed by a liquidation isn&apos;t necessarily wrong — the owner may have added collateral — so this is shown as counts, not a rate of mistakes.
        </div>
      </div>

      <div className="grid two">
        <BreakdownTable title="By venue" forward={forward} rows={a.byVenue} group="venue" />
        <BreakdownTable title="By size range" forward={forward} rows={a.bySize} group="size" />
        <BreakdownTable title="By position type (at the time)" forward={forward} rows={a.byType} group="type" />
        <BreakdownTable title="By rules version — never pooled" forward={forward} rows={a.byRules} group="rules" />
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
