/**
 * INTEL → CHANGES (Release 3, changes-1.0.0). Risk-relevant parameters read every hour from Tydro's and Nado's
 * own contracts; a difference between two readings is a change record. Written by the hourly census
 * (history/params/latest.json, history/changes/<month>.json).
 */
import { useMemo, useState } from 'react';
import { CHANGES, paramLabel, type AggSummary, type ChangeRecord, type ParamsLatest } from '@aegis/census';
import { INK_EXPLORER } from '@aegis/ink-io';
import { Panel } from './bits';
import { when } from './HistoryBits';
import { useChanges, useHistoryIndex, useParams } from '../lib/history';
import { WELL_ON } from '../lib/census';
import { brandText } from '@aegis/glyphs';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const Val = ({ v }: { v: string | null }) =>
  v === null ? <span className="faint">—</span> : ADDR.test(v) ? (
    <a href={`${INK_EXPLORER}/address/${v}`} target="_blank" rel="noreferrer" title={v}>{v.slice(0, 8)}…{v.slice(-6)}</a>
  ) : (
    <span>{v}</span>
  );

export function ChangesPanel() {
  const idx = useHistoryIndex();
  const p = useParams();
  const c = useChanges(idx.status === 'ok' ? idx.index : null);
  const notStarted = p.status === 'none';
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Panel title="Protocol Change Monitor" rail="var(--violet)" testId="intel-changes" right={<span className="mono">{CHANGES.VERSION}</span>}>
        <div className="stack" style={{ gap: 12 }}>
          {p.status === 'loading' ? <div className="dim" role="status">Loading…</div> : null}
          {p.status === 'error' ? <div className="banner red" role="alert">Couldn&apos;t load ({p.message}). Nothing is shown rather than a guess.</div> : null}
          {notStarted ? (
            <div className="banner" data-testid="changes-not-started">
              NOT MONITORING YET — the hourly scan takes its first reading of every parameter after this update. Changes before that aren&apos;t known to Phrourax and aren&apos;t reconstructed.
            </div>
          ) : null}
          {p.status === 'ok' ? <Since p={p.v} /> : null}
          {p.status === 'ok' ? (
            c.status === 'ok' ? (
              <ChangeList records={c.records} />
            ) : c.status === 'error' ? (
              <div className="banner red" role="alert">Change records couldn&apos;t be loaded ({c.message}).</div>
            ) : idx.status === 'none' || idx.status === 'error' ? (
              <div className="dim">No change records yet.</div>
            ) : (
              <div className="dim" role="status">Loading change records…</div>
            )
          ) : null}
        </div>
      </Panel>
      {p.status === 'ok' ? <Browser p={p.v} /> : null}
    </div>
  );
}

function Since({ p }: { p: ParamsLatest }) {
  const ageH = (Date.now() - p.at) / 3_600_000;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <p className="dim" style={{ fontSize: 13, lineHeight: 1.55, margin: 0 }}>
        Every hour Phrourax reads the parameters that decide when a position is liquidated — thresholds, weights, caps, oracle sources, contract upgrades — straight from the protocols&apos; contracts, and compares them with the previous reading. A change is shown with the two blocks it happened between.
      </p>
      <div className="faint mono" style={{ fontSize: 11 }} data-testid="changes-since">
        Monitoring {Object.keys(p.params).length.toLocaleString('en-US')} parameters since {when(Date.parse(p.since))} · last read at block {p.block.toLocaleString('en-US')} ({when(p.at)})
        {ageH > 3 ? <b style={{ color: 'var(--amber)' }}> · STALE — {ageH.toFixed(0)} h old</b> : null}
      </div>
    </div>
  );
}

function Impact({ label, s }: { label: string; s: AggSummary | null }) {
  return (
    <div>
      <div className="faint mono" style={{ fontSize: 10.5 }}>{label}</div>
      {s ? (
        <div style={{ fontSize: 12.5 }}>
          <b>{s.near}</b> near liquidation · {s.watch} watch · <b>{s.nearMaterial}</b> near (≥ $1k){s.stress ? ` · stress ${s.stress}` : ''}
          <div className="faint mono" style={{ fontSize: 10.5 }}>block {s.block.toLocaleString('en-US')} · {when(Date.parse(s.at))}</div>
        </div>
      ) : (
        <div className="faint" style={{ fontSize: 12.5 }}>not recorded</div>
      )}
    </div>
  );
}

function ChangeList({ records }: { records: ChangeRecord[] }) {
  const [all, setAll] = useState(false);
  if (!records.length) return <div className="dim" data-testid="changes-none">No parameter has changed since monitoring began.</div>;
  const shown = all ? records : records.slice(0, 25);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="panel-title">{records.length} change{records.length === 1 ? '' : 's'} recorded · newest first</div>
      <ul className="change-list" data-testid="changes-list">
        {shown.map((r) => (
          <li key={r.id} className="change-item">
            <div className="row" style={{ gap: 8 }}>
              <span className="mono oracle-chip" style={{ color: r.protocol === 'tydro' ? 'var(--cyan)' : 'var(--violet)', borderColor: 'currentColor' }}>{r.protocol.toUpperCase()}</span>
              <b className="mono">{r.subject}</b>
              <span style={{ fontSize: 13 }}>{paramLabel(r.name)}</span>
              {r.kind !== 'changed' ? <span className="mono faint">{r.kind}</span> : null}
            </div>
            <div className="change-val">
              <del><Val v={r.old} /></del> → <ins><Val v={r.new} /></ins>
            </div>
            <div className="faint mono" style={{ fontSize: 11 }}>
              between block {r.between.fromBlock.toLocaleString('en-US')} ({when(r.between.fromAt)}) and {r.between.toBlock.toLocaleString('en-US')} ({when(r.between.toAt)})
            </div>
            <div style={{ fontSize: 12 }}>
              <span className="dim">Transaction: </span>
              {r.txCandidates && r.txCandidates.length ? (
                <>
                  {r.txCandidates.map((t, i) => (
                    <span key={t}>{i ? ', ' : ''}<a className="mono" href={`${INK_EXPLORER}/tx/${t}`} target="_blank" rel="noreferrer">{t.slice(0, 10)}…</a></span>
                  ))}
                  <span className="faint"> — {brandText(r.txNote)}</span>
                </>
              ) : (
                <span className="faint">{brandText(r.txNote)}</span>
              )}
            </div>
            {WELL_ON ? (
              <>
                <div className="grid two" style={{ gap: 8 }}>
                  <Impact label="PHROURAX COUNTS JUST BEFORE" s={r.impact.before} />
                  <Impact label="JUST AFTER" s={r.impact.after} />
                </div>
                <div className="note-text">{brandText(r.impact.note)}</div>
              </>
            ) : (
              <div className="note-text">Before/after wallet counts are locked with the well until the readings are verified.</div>
            )}
            <div className="faint mono" style={{ fontSize: 10.5 }}>{r.verification} · {r.reader}</div>
          </li>
        ))}
      </ul>
      {records.length > 25 ? <button type="button" className="sq-btn" onClick={() => setAll(!all)}>{all ? 'SHOW FEWER' : `SHOW ALL ${records.length}`}</button> : null}
    </div>
  );
}

function Browser({ p }: { p: ParamsLatest }) {
  const [q, setQ] = useState('');
  const [proto, setProto] = useState<'all' | 'tydro' | 'nado'>('all');
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return Object.entries(p.params)
      .filter(([, v]) => proto === 'all' || v.protocol === proto)
      .filter(([k, v]) => !needle || `${k} ${paramLabel(v.name)} ${v.v}`.toLowerCase().includes(needle))
      .sort(([a], [b]) => a.localeCompare(b));
  }, [p, q, proto]);
  const CAP = 300;
  return (
    <Panel title="Monitored parameters" rail="var(--violet)" testId="changes-params" right={<span className="mono">current values</span>}>
      <div className="stack" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 12 }}>
          <div className="view-switch" role="group" aria-label="Protocol">
            {(['all', 'tydro', 'nado'] as const).map((k) => (
              <button key={k} type="button" className={`sq-btn${proto === k ? ' on' : ''}`} aria-pressed={proto === k} onClick={() => setProto(k)}>{k.toUpperCase()}</button>
            ))}
          </div>
          <input className="param-filter" type="search" placeholder="filter: WETH, threshold, implementation…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter parameters" data-testid="changes-filter" />
        </div>
        <div className="table-wrap" style={{ maxHeight: 460, overflow: 'auto' }}>
          <table className="t">
            <thead><tr><th>Subject</th><th>Parameter</th><th>Value</th><th className="hide-narrow">Read from</th></tr></thead>
            <tbody>
              {rows.slice(0, CAP).map(([k, v]) => (
                <tr key={k}>
                  <td className="mono">{v.protocol} · {v.subject}</td>
                  <td>{paramLabel(v.name)}</td>
                  <td className="mono"><Val v={v.v} /></td>
                  <td className="mono faint wrap-text hide-narrow" style={{ fontSize: 11 }}>{v.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="note-text">{rows.length > CAP ? `Showing ${CAP} of ${rows.length} — narrow the filter. ` : `${rows.length} shown. `}Values are as the contracts return them (basis points where labelled).</div>
        {p.unsupported.length ? (
          <details>
            <summary className="mono dim" style={{ fontSize: 11, cursor: 'pointer' }}>Not monitored — couldn&apos;t be read ({p.unsupported.length})</summary>
            <ul className="dim" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
              {p.unsupported.map((u) => <li key={u} className="wrap-text">{u}</li>)}
            </ul>
            <div className="note-text">A parameter Phrourax can&apos;t read is listed here rather than claimed as watched.</div>
          </details>
        ) : null}
      </div>
    </Panel>
  );
}
