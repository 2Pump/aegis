/**
 * INTEL → LIQUIDATIONS: the Liquidation Ledger, its analytics, and Cascade Replay.
 *
 * Historical only. Time-ordered, never ranked; wallets shortened; each row links to its (already public)
 * transaction on the explorer — not to a live wallet page. No export, no download, no list of who's next.
 */
import { useEffect, useMemo, useState } from 'react';
import { INK_EXPLORER } from '@aegis/ink-io';
import { LEDGER, cascades, leadHours, ledgerSummary, type AggPoint, type Cascade, type LedgerRecord } from '@aegis/census';
import { SIZE_LABEL } from '@aegis/glyphs';
import { Panel } from './bits';
import { CountChart, RangePicker, when } from './HistoryBits';
import { aggAround, useHistoryIndex, useLedger, type Range } from '../lib/history';
import type { HistoryIndex } from '@aegis/census';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const hrs = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`);
const PAGE = 50;

export function aegisBefore(r: LedgerRecord): { text: string; tone: 'red' | 'amber' | 'dim' | 'faint' } {
  const a = r.aegis;
  if (!a.evaluable) return { text: 'before recording', tone: 'faint' };
  if (!a.before) return { text: 'not seen by AEGIS', tone: 'dim' };
  const near = leadHours(r, 'near');
  if (near !== null) return { text: `NEAR ${a.leadIsMinimum ? '≥ ' : ''}${hrs(near)} before`, tone: 'red' };
  const watch = leadHours(r, 'watch');
  if (watch !== null) return { text: `WATCH only, ${a.leadIsMinimum ? '≥ ' : ''}${hrs(watch)} before`, tone: 'amber' };
  return { text: 'no warning', tone: 'dim' };
}

const TONE: Record<string, string | undefined> = { red: 'var(--red)', amber: 'var(--amber)', dim: 'var(--ink-dim)', faint: 'var(--ink-faint)' };

export function LiquidationsPanel() {
  const idx = useHistoryIndex();
  const index = idx.status === 'ok' ? idx.index : null;
  const [range, setRange] = useState<Range>('30d');
  const [venue, setVenue] = useState<'all' | 'tydro' | 'nado'>('all');
  const led = useLedger(range, index);
  const cur = index?.ledger ?? null;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Panel title="Liquidation ledger" rail="var(--red)" testId="liq-ledger" right={<span className="mono">historical · from on-chain events</span>}>
        <div className="stack" style={{ gap: 12 }}>
          {idx.status === 'loading' ? <div className="dim" role="status">Loading…</div> : null}
          {idx.status === 'error' ? <div className="banner red" role="alert">Couldn't load ({idx.message}). Nothing is shown rather than a guess.</div> : null}
          {idx.status === 'none' || (index && !cur) ? (
            <div className="banner" data-testid="liq-not-started">
              NOT RECORDING YET — the first hourly scan after this update starts the ledger: new liquidations from then on, and a history scan back to each protocol's launch that runs a few minutes per hour until it's complete.
            </div>
          ) : null}
          {cur ? (
            <div className="faint mono wrap-text" style={{ fontSize: 11 }} data-testid="liq-coverage">
              Sources: Tydro Pool <span className="mono">LiquidationCall</span> and Nado Clearinghouse <span className="mono">Liquidation</span> events. Live up to block {cur.forwardTo.toLocaleString('en-US')}. History scan{' '}
              {cur.done ? (
                <b>complete</b>
              ) : (
                <b>
                  {Math.floor(((cur.backfillNext - cur.backfillFrom) / Math.max(1, cur.forwardFrom - cur.backfillFrom)) * 100)}% — block {cur.backfillNext.toLocaleString('en-US')} of {cur.forwardFrom.toLocaleString('en-US')}; older liquidations are still being added
                </b>
              )}
              . {cur.skipped ? `${cur.skipped} malformed log(s) skipped. ` : ''}Version {LEDGER.VERSION}.
            </div>
          ) : null}
          {cur ? (
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <RangePicker value={range} onChange={setRange} testId="liq-range" />
              <div className="view-switch" role="group" aria-label="Venue">
                {(['all', 'tydro', 'nado'] as const).map((v) => (
                  <button key={v} type="button" className={`sq-btn${venue === v ? ' on' : ''}`} aria-pressed={venue === v} onClick={() => setVenue(v)}>
                    {v === 'all' ? 'BOTH' : v.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {cur && led.status === 'loading' ? <div className="dim" role="status">Loading…</div> : null}
          {cur && led.status === 'none' ? <div className="dim" data-testid="liq-empty">No liquidations recorded yet.</div> : null}
          {cur && led.status === 'error' ? <div className="banner red" role="alert">Couldn't load ({led.message}).</div> : null}
          {cur && led.status === 'ok' ? <Ledger records={led.records.filter((r) => venue === 'all' || r.venue === venue)} from={led.from} to={led.to} index={index!} /> : null}
        </div>
      </Panel>
    </div>
  );
}

function Ledger({ records, from, to, index }: { records: LedgerRecord[]; from: number; to: number; index: HistoryIndex }) {
  const s = useMemo(() => ledgerSummary(records), [records]);
  const cs = useMemo(() => cascades(records), [records]);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => setPage(0), [records]);
  const rows = useMemo(() => [...records].sort((a, b) => b.at - a.at), [records]);
  const days = useMemo(() => {
    const dayMs = 86_400_000;
    const start = Math.floor(from / dayMs) * dayMs;
    const pts: Array<{ t: number; v: number }> = [];
    for (let t = start; t <= to; t += dayMs) pts.push({ t, v: s.byDay[new Date(t).toISOString().slice(0, 10)] ?? 0 });
    return pts;
  }, [s, from, to]);
  const buckets = useMemo(() => {
    const b = [
      ['< 1 h', 0, 1],
      ['1–6 h', 1, 6],
      ['6–24 h', 6, 24],
      ['1–7 days', 24, 168],
      ['> 7 days', 168, Infinity],
    ] as const;
    return b.map(([k, lo, hi]) => [k, s.leadHours.filter((h) => h >= lo && h < hi).length] as const);
  }, [s]);
  const opened = cs.find((c) => c.id === open) ?? null;

  if (!records.length) return <div className="dim" data-testid="liq-empty">No liquidations in this range.</div>;
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="liq-tiles" data-testid="liq-summary">
        <Tile k="liquidations" v={s.total} sub={Object.entries(s.byVenue).map(([v, n]) => `${v} ${n}`).join(' · ')} />
        <Tile k="AEGIS had NEAR before" v={s.warnedNear} sub={`of ${s.evaluable} it could judge`} tone="red" />
        <Tile k="WATCH only" v={s.warnedWatchOnly} sub={`of ${s.evaluable}`} tone="amber" />
        <Tile k="no warning" v={s.notWarned} sub={`${s.notSeen} of them never seen by AEGIS`} />
        <Tile k="before recording" v={s.beforeRecording} sub="not used to judge AEGIS" tone="faint" />
        <Tile k="partial records" v={s.partial} sub="some field unavailable" tone="faint" />
      </div>

      <div>
        <div className="panel-title" style={{ marginBottom: 6 }}>Liquidations per day</div>
        <CountChart series={[{ name: 'Liquidations', color: 'var(--red)', points: days }]} from={from} to={to} gaps={[]} label={`Liquidations per day: ${days.filter((d) => d.v).map((d) => `${new Date(d.t).toISOString().slice(0, 10)} ${d.v}`).join(', ')}`} height={120} />
      </div>

      <div className="grid two">
        <div>
          <div className="panel-title" style={{ marginBottom: 6 }}>By asset family</div>
          <CountTable rows={Object.entries(s.byFamily)} testId="liq-by-family" />
        </div>
        <div>
          <div className="panel-title" style={{ marginBottom: 6 }}>By size range</div>
          <CountTable rows={Object.entries(s.bySize).map(([k, n]) => [k === 'unavailable' ? 'unavailable' : SIZE_LABEL[k as keyof typeof SIZE_LABEL] ?? k, n])} />
        </div>
      </div>

      <div>
        <div className="panel-title" style={{ marginBottom: 6 }}>Warning lead time — liquidations AEGIS had marked NEAR</div>
        {s.leadHours.length ? (
          <>
            <CountTable rows={buckets.map(([k, n]) => [k, n])} keepOrder />
            <div className="faint" style={{ fontSize: 12 }}>
              Median {hrs(s.leadHoursMedian!)} · {s.leadHours.length} liquidation(s). Recorded hourly, so a lead time is accurate to about an hour; "≥" means the warning was already on when recording began.
            </div>
          </>
        ) : (
          <div className="dim">None yet in this range{s.beforeRecording === s.total ? ' — every liquidation here happened before AEGIS began recording' : ''}.</div>
        )}
      </div>

      <div>
        <div className="panel-title" style={{ marginBottom: 6 }}>Cascades · rule {LEDGER.CASCADE_VERSION}</div>
        <div className="faint" style={{ fontSize: 12, marginBottom: 6 }}>
          {LEDGER.CASCADE_MIN_EVENTS}+ liquidations, each within {LEDGER.CASCADE_GAP_MIN} minutes of the one before. Grouping shows they happened together — not why.
        </div>
        {cs.length ? (
          <div className="table-wrap">
            <table className="t" data-testid="liq-cascades">
              <thead>
                <tr><th>Started (UTC)</th><th>Lasted</th><th>Liquidations</th><th>Venues</th><th>Grouping</th><th /></tr>
              </thead>
              <tbody>
                {cs.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{when(c.start)}</td>
                    <td className="mono">{hrs((c.end - c.start) / 3_600_000)}</td>
                    <td className="num">{c.size}</td>
                    <td className="mono">{Object.entries(c.venues).map(([v, n]) => `${v} ${n}`).join(' · ')}</td>
                    <td>{c.centredOn ? `${Math.round(c.centredOn.share * 100)}% ${c.centredOn.family}` : 'timing only'}{c.uncertain ? <span className="faint"> · uncertain</span> : null}</td>
                    <td><button type="button" className="sq-btn" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>{open === c.id ? 'CLOSE' : 'REPLAY'}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="dim">No cascades in this range.</div>
        )}
        {opened ? <Replay c={opened} records={records} index={index} /> : null}
      </div>

      <div>
        <div className="panel-title" style={{ marginBottom: 6 }}>Ledger · newest first</div>
        <div className="table-wrap">
          <table className="t" data-testid="liq-table">
            <caption className="sr-only">Liquidations, newest first</caption>
            <thead>
              <tr><th>When (UTC)</th><th>Venue</th><th>Wallet</th><th>What</th><th>Size</th><th>AEGIS before</th><th>Record</th></tr>
            </thead>
            <tbody>
              {rows.slice(page * PAGE, page * PAGE + PAGE).map((r) => {
                const b = aegisBefore(r);
                return (
                  <tr key={r.id} data-testid="liq-row">
                    <td className="mono">
                      <a href={`${INK_EXPLORER}/tx/${r.tx}`} target="_blank" rel="noreferrer" title="Open the transaction on the explorer">{when(r.at)}</a>
                    </td>
                    <td className="mono">{r.venue}</td>
                    <td className="mono">{short(r.wallet)}{r.subaccountKind === 'isolated' ? <span className="faint"> · isolated</span> : null}</td>
                    <td className="mono">{r.venue === 'tydro' ? `${r.collateral} seized · ${r.debt} repaid` : `${r.product}${r.isEncodedSpread ? ' (spread)' : ''}`}</td>
                    <td className="mono" title={r.sizeBasis ?? undefined}>{r.sizeBand ? SIZE_LABEL[r.sizeBand] : 'unavailable'}</td>
                    <td className="mono" style={{ color: TONE[b.tone] }}>{b.text}</td>
                    <td className="mono faint" style={{ fontSize: 11 }} title={r.unavailable.join('; ') || undefined}>{r.completeness === 'COMPLETE' ? 'complete' : 'partial'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length > PAGE ? (
          <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
            <button type="button" className="sq-btn" disabled={page === 0} onClick={() => setPage(page - 1)}>NEWER</button>
            <span className="faint mono" style={{ fontSize: 11 }}>
              {page * PAGE + 1}–{Math.min(rows.length, page * PAGE + PAGE)} of {rows.length}
            </span>
            <button type="button" className="sq-btn" disabled={(page + 1) * PAGE >= rows.length} onClick={() => setPage(page + 1)}>OLDER</button>
          </div>
        ) : null}
        <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
          Historical, public transactions — not a list of who might be next. Size is a range ({'"'}debt repaid at that block's prices{'"'} on Tydro; the event's quote amount on Nado). Hover "partial" to see what's unavailable.
        </div>
      </div>
    </div>
  );
}

function Tile({ k, v, sub, tone }: { k: string; v: number; sub: string; tone?: 'red' | 'amber' | 'faint' }) {
  return (
    <div className="liq-tile">
      <div className="panel-title">{k}</div>
      <div className="num" style={{ fontSize: 22, color: tone ? TONE[tone] : undefined }}>{v.toLocaleString('en-US')}</div>
      <div className="faint" style={{ fontSize: 11 }}>{sub}</div>
    </div>
  );
}

function CountTable({ rows, testId, keepOrder = false }: { rows: ReadonlyArray<readonly [string, number]>; testId?: string; keepOrder?: boolean }) {
  const total = rows.reduce((a, [, n]) => a + n, 0);
  return (
    <div className="table-wrap">
      <table className="t" data-testid={testId}>
        <tbody>
          {(keepOrder ? [...rows] : [...rows].sort((a, b) => b[1] - a[1])).map(([k, n]) => (
            <tr key={k}>
              <td>{k}</td>
              <td className="num">{n.toLocaleString('en-US')}</td>
              <td className="num faint">{total ? `${((n / total) * 100).toFixed(0)}%` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Replay one cascade as a timeline, from what was actually recorded — gaps said, never filled. */
function Replay({ c, records, index }: { c: Cascade; records: LedgerRecord[]; index: HistoryIndex }) {
  const members = useMemo(() => records.filter((r) => c.ids.includes(r.id)).sort((a, b) => a.at - b.at), [records, c]);
  const [agg, setAgg] = useState<AggPoint[] | null>(null);
  useEffect(() => {
    let alive = true;
    setAgg(null);
    aggAround(c.start - 6 * 3_600_000, c.end + 6 * 3_600_000, index)
      .then((p) => alive && setAgg(p))
      .catch(() => alive && setAgg([]));
    return () => {
      alive = false;
    };
  }, [c, index]);
  const firstNear = members.map((r) => r.aegis.nearSince).filter((x): x is number => x !== null).sort((a, b) => a - b)[0] ?? null;
  const before = agg?.filter((p) => Date.parse(p.at) <= c.start).at(-1) ?? null;
  const during = agg?.filter((p) => Date.parse(p.at) >= c.start && Date.parse(p.at) <= c.end + 3_600_000) ?? [];
  const peakNear = during.reduce<AggPoint | null>((m, p) => (!m || p.risk['0'][2] > m.risk['0'][2] ? p : m), null);
  const recovered = before ? agg?.find((p) => Date.parse(p.at) > c.end && p.risk['0'][2] <= before.risk['0'][2]) ?? null : null;
  const stressChanges = (agg ?? []).filter((p) => p.stress).map((p) => `${when(Date.parse(p.at))}: ${p.stress!.level}`);
  const steps: Array<[string, string]> = [
    ['1 · Price or oracle move', 'Not recorded yet — AEGIS starts recording oracle prices with Oracle Watch (Release 3).'],
    ['2 · First wallet AEGIS had in danger', firstNear !== null ? `${when(firstNear)} — the earliest NEAR warning among these wallets` : agg && agg.length ? 'No member was recorded as NEAR beforehand.' : 'Not recorded (before AEGIS began recording).'],
    ['3 · AEGIS stress', agg === null ? 'loading…' : agg.length ? `${before ? `${before.risk['0'][2]} wallets near liquidation before` : 'no point before'} → ${peakNear ? `${peakNear.risk['0'][2]} at the busiest recorded hour` : 'no point during'}${stressChanges.length ? ` · Ink Stress Level: ${stressChanges.join(', ')}` : ''}` : 'Not recorded (before AEGIS began recording).'],
    ['4 · First liquidation', `${when(members[0]!.at)} · ${members[0]!.venue} · ${short(members[0]!.wallet)}`],
    ['5 · Then', `${members.length - 1} more over ${hrs((c.end - c.start) / 3_600_000)}`],
    ['6 · Peak', `${c.peak.count} liquidations in the ${LEDGER.CASCADE_PEAK_MIN} minutes from ${when(c.peak.at)}`],
    ['7 · Afterwards', recovered ? `Near-liquidation count back to its earlier level by ${when(Date.parse(recovered.at))}` : agg && agg.length ? 'Not back to its earlier level within the recorded 6 hours.' : 'Not recorded.'],
  ];
  return (
    <div className="hist-box" style={{ marginTop: 10 }} data-testid="liq-replay">
      <div className="panel-title">Replay · {when(c.start)}</div>
      <ol className="replay">
        {steps.map(([k, v]) => (
          <li key={k}>
            <b>{k}</b>
            <span>{v}</span>
          </li>
        ))}
      </ol>
      <div className="faint" style={{ fontSize: 12 }}>Why grouped: {c.reasons.map((x) => x.replace(/\.$/, '')).join(' · ')}.</div>
      <div className="table-wrap" style={{ marginTop: 6 }}>
        <table className="t">
          <thead><tr><th>When (UTC)</th><th>Venue</th><th>Wallet</th><th>What</th><th>Size</th><th>AEGIS before</th></tr></thead>
          <tbody>
            {members.map((r) => (
              <tr key={r.id}>
                <td className="mono"><a href={`${INK_EXPLORER}/tx/${r.tx}`} target="_blank" rel="noreferrer">{when(r.at)}</a></td>
                <td className="mono">{r.venue}</td>
                <td className="mono">{short(r.wallet)}</td>
                <td className="mono">{r.venue === 'tydro' ? `${r.collateral} / ${r.debt}` : r.product}</td>
                <td className="mono">{r.sizeBand ? SIZE_LABEL[r.sizeBand] : 'unavailable'}</td>
                <td className="mono" style={{ color: TONE[aegisBefore(r).tone] }}>{aegisBefore(r).text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
