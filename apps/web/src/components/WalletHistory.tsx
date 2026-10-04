/**
 * Wallet Flight Recorder — the HISTORY section of a wallet page.
 *
 *  - Recorded states: what the hourly scan recorded for this wallet AT THE TIME (risk, position type, size range,
 *    venues), with the rules version each was classified under. Never rewritten.
 *  - Read at a past block: this wallet re-read from the chain at a chosen block, in this browser, NOW. Shown next to
 *    what was recorded then, never merged: AS CLASSIFIED THEN vs USING CURRENT RULES.
 *
 * Exact health factors and margin buffers appear only in the past-block read (on this page, like the live plate);
 * the recorded history files are balance-free by design.
 */
import { useState } from 'react';
import { RULES, classify, type HullTemp, type Pose } from '@aegis/pose';
import { NO_TYPE_LABEL, RISK_LABEL, SIZE_LABEL, TAG_LABEL } from '@aegis/glyphs';
import type { WalletState } from '@aegis/census';
import { Panel, TagChip } from './bits';
import { RangePicker, RiskLegend, RiskStrip, when } from './HistoryBits';
import { recordedStateAt, useHistoryIndex, useLedger, useWalletHistory, type Range } from '../lib/history';
import { aegisBefore } from './Liquidations';
import { INK_EXPLORER } from '@aegis/ink-io';
import type { HistoryIndex } from '@aegis/census';
import { blockAtTime, blockTime, loadBookAt } from '../lib/sensors';

const typeText = (s: { primary: WalletState['primary'] }) => (s.primary ? TAG_LABEL[s.primary] : NO_TYPE_LABEL);
const venuesText = (v: { tydro: boolean; nado: boolean }) => [v.tydro ? 'Tydro' : null, v.nado ? 'Nado' : null].filter(Boolean).join(' + ') || '—';

export function WalletHistory({ address }: { address: string }) {
  const idx = useHistoryIndex();
  const [range, setRange] = useState<Range>('7d');
  const index = idx.status === 'ok' ? idx.index : null;
  const h = useWalletHistory(address, range, index);

  return (
    <Panel title="History — flight recorder" rail="var(--violet)" testId="wallet-history" right={<span className="mono">recorded live · balance-free</span>}>
      <div className="stack" style={{ gap: 12 }}>
        {idx.status === 'loading' ? <div className="dim" role="status">Loading the recorded history…</div> : null}
        {idx.status === 'error' ? <div className="banner red" role="alert">History couldn't be loaded ({idx.message}). Nothing is shown rather than a guess.</div> : null}
        {idx.status === 'none' ? (
          <div className="banner" data-testid="history-not-started">
            NOT RECORDING YET — the hourly scan starts the flight recorder once this version is deployed. Nothing before that is recorded, and nothing is backfilled or made up.
          </div>
        ) : null}
        {index ? (
          <>
            <div className="faint mono" style={{ fontSize: 11 }} data-testid="history-since">
              Recorded live by the hourly scan since {index.firstAt ? when(Date.parse(index.firstAt)) : '—'} (block {index.firstBlock?.toLocaleString('en-US') ?? '—'}). Nothing earlier is recorded or reconstructed.
            </div>
            <RangePicker value={range} onChange={setRange} testId="history-range" />
            {h.status === 'loading' ? <div className="dim" role="status">Loading…</div> : null}
            {h.status === 'error' ? <div className="banner red" role="alert">History couldn't be loaded ({h.message}).</div> : null}
            {h.status === 'ok' ? <Recorded h={h} /> : null}
            <WalletLiquidations address={address} range={range} index={index} />
          </>
        ) : null}

        <PastRead address={address} />

        <details className="hist-notyet" data-testid="history-not-recorded">
          <summary className="mono dim">What this history doesn't contain (yet)</summary>
          <ul className="dim">
            <li>
              <b>Health factor, margin buffer, leverage, net exposure over time</b> — not stored: AEGIS's public files never carry a wallet's numbers. Read them for
              any past block below (computed from the chain in your browser).
            </li>
            <li>
              <b>Deposits, withdrawals, borrows, repayments, perp entries and exits, funding</b> — not recorded. This wallet's <b>liquidations</b> are, above (from the
              Liquidation Ledger).
            </li>
          </ul>
        </details>
      </div>
    </Panel>
  );
}

type Ok = Extract<ReturnType<typeof useWalletHistory>, { status: 'ok' }>;

function Recorded({ h }: { h: Ok }) {
  const { timeline, inRange, gaps, from, to } = h;
  // the state in force when the range starts, then every change inside it
  const before = [...timeline].reverse().find((s) => s.at < from) ?? null;
  const shown = before ? [before, ...inRange] : inRange;
  const spans = shown.map((s, i) => ({
    from: Math.max(s.at, from),
    to: shown[i + 1]?.at ?? to,
    hull: (s.primary === 'EMPTY' ? 'UNKNOWN' : s.hullTemp) as HullTemp,
    text: `${when(s.at)} · ${RISK_LABEL[s.hullTemp]} · ${typeText(s)}`,
  }));
  const rows = [...inRange].reverse();
  const MAX = 200;
  if (!shown.length) {
    return (
      <div className="dim" data-testid="history-empty">
        No state recorded for this wallet in this range. It may not have held a position while recording, or wasn't found yet. That is not the same as "safe".
      </div>
    );
  }
  return (
    <>
      <RiskStrip spans={spans} gaps={gaps} from={from} to={to} label={`Risk over time: ${spans.map((s) => s.text).join('; ')}`} />
      <div className="hist-axis mono faint"><span>{when(from)}</span><span>now</span></div>
      <RiskLegend />
      {before ? (
        <div className="faint" style={{ fontSize: 12 }}>
          At the start of this range: <b>{RISK_LABEL[before.hullTemp]}</b> · {typeText(before)} (recorded {when(before.at)}, block {before.block.toLocaleString('en-US')}).
        </div>
      ) : (
        <div className="faint" style={{ fontSize: 12 }}>The strip starts at this wallet's first recorded state{shown[0] && shown[0].at > from ? ` (${when(shown[0].at)}) — nothing was recorded for it before that` : ''}.</div>
      )}
      {gaps.length ? (
        <div className="faint" style={{ fontSize: 12 }} data-testid="history-gaps">
          Data gaps (no hourly scan for over 2 h): {gaps.slice(0, 4).map((g) => `${when(g.from)} → ${when(g.to)}`).join(' · ')}
          {gaps.length > 4 ? ` · +${gaps.length - 4} more` : ''}
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="t" data-testid="history-table">
          <caption className="sr-only">Recorded states of this wallet, newest first</caption>
          <thead>
            <tr><th>When (UTC)</th><th>Block</th><th>Risk</th><th>Position type</th><th>Size</th><th>Venues</th><th>Rules</th><th>Source</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={8} className="dim">No change in this range — the state at the start of the range held throughout.</td></tr>
            ) : null}
            {rows.slice(0, MAX).map((s, i) => {
              const older = rows[i + 1] ?? (before && i === rows.length - 1 ? before : undefined);
              const rulesChanged = older && older.rulesVersion !== s.rulesVersion;
              return (
                <tr key={`${s.block}${s.kind}`} data-testid="history-row">
                  <td className="mono">{when(s.at)}</td>
                  <td className="mono">{s.block.toLocaleString('en-US')}</td>
                  <td className="mono" style={{ color: RISK_COLOR_TEXT[s.hullTemp] }}>{s.primary === 'EMPTY' ? 'no position' : RISK_LABEL[s.hullTemp]}</td>
                  <td><div className="tags hist-tags">{s.tags.length ? s.tags.map((t) => <TagChip key={t} tag={t} />) : <TagChip tag={null} />}</div></td>
                  <td className="mono">{SIZE_LABEL[s.band]}</td>
                  <td className="mono">{venuesText(s.venues)}</td>
                  <td className="mono">{s.rulesVersion}{rulesChanged ? <b className="proof-old"> (rules changed)</b> : null}</td>
                  <td className="mono faint" style={{ fontSize: 11 }}>{s.kind === 'B' ? 'monthly bookmark · recorded live' : 'change · recorded live'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > MAX ? <div className="faint mono" style={{ fontSize: 11 }}>Showing the newest {MAX} of {rows.length}. Pick a shorter range to see older ones.</div> : null}
    </>
  );
}

const RISK_COLOR_TEXT: Record<HullTemp, string | undefined> = { NOMINAL: undefined, ELEVATED: 'var(--amber)', CRITICAL: 'var(--red)', UNKNOWN: 'var(--slate)' };

type PastState =
  | { s: 'idle' }
  | { s: 'busy'; what: string }
  | { s: 'error'; message: string }
  | { s: 'ok'; block: number; at: number; pose: Pose; recorded: WalletState | null; tydro: string | null; nado: string | null; hf: number | null; buffer: number | null; unreadable: boolean };

/** Read the wallet at a past block or time, and set it beside what was recorded then. */
function PastRead({ address }: { address: string }) {
  const [input, setInput] = useState('');
  const [st, setSt] = useState<PastState>({ s: 'idle' });

  const go = async () => {
    const raw = input.trim();
    try {
      let block: number;
      let at: number;
      if (/^\d{1,10}$/.test(raw.replace(/,/g, ''))) {
        block = Number(raw.replace(/,/g, ''));
        if (block < 1) throw new Error('block must be 1 or more');
        setSt({ s: 'busy', what: `reading block ${block.toLocaleString('en-US')}…` });
        at = await blockTime(block);
      } else {
        const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`);
        if (!Number.isFinite(t)) throw new Error('enter a block number, or a UTC date and time like 2026-10-01 14:00');
        if (t > Date.now()) throw new Error("that's in the future");
        setSt({ s: 'busy', what: 'finding the block for that time…' });
        ({ block, at } = await blockAtTime(t));
      }
      setSt({ s: 'busy', what: `reading the wallet at block ${block.toLocaleString('en-US')}…` });
      const [{ book }, recorded] = await Promise.all([loadBookAt(address as `0x${string}`, block), recordedStateAt(address, at, block).catch(() => null)]);
      const pose = classify(book);
      setSt({
        s: 'ok',
        block,
        at,
        pose,
        recorded,
        tydro: book.tydro.status === 'OK' ? null : book.tydro.message,
        nado: book.nado.status === 'OK' ? null : book.nado.message,
        hf: pose.metrics.hf,
        buffer: pose.metrics.nadoBuffer,
        unreadable: book.tydro.status !== 'OK' && book.nado.status !== 'OK',
      });
    } catch (e) {
      setSt({ s: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="hist-past" data-testid="history-past">
      <div className="panel-title" style={{ marginBottom: 6 }}>Read at a past block or time</div>
      <form
        className="row"
        style={{ gap: 8, flexWrap: 'wrap' }}
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <label className="sr-only" htmlFor="past-at">Block number or UTC time</label>
        <input id="past-at" className="past-input mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder="block 57,600,000 or 2026-10-01 14:00 (UTC)" data-testid="past-input" />
        <button className="sq-btn" type="submit" disabled={!input.trim() || st.s === 'busy'} data-testid="past-go">READ</button>
      </form>
      {st.s === 'busy' ? <div className="dim" role="status">{st.what}</div> : null}
      {st.s === 'error' ? <div className="banner red" role="alert">{st.message}</div> : null}
      {st.s === 'ok' ? <PastResult r={st} /> : null}
    </div>
  );
}

function PastResult({ r }: { r: Extract<PastState, { s: 'ok' }> }) {
  const differs = r.recorded && !r.unreadable && (r.recorded.primary !== r.pose.primary || r.recorded.hullTemp !== r.pose.hullTemp);
  const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
  return (
    <div className="stack" style={{ gap: 8, marginTop: 8 }} data-testid="past-result">
      <div className="faint mono" style={{ fontSize: 11 }}>
        Block {r.block.toLocaleString('en-US')} · {when(r.at)}
      </div>
      <div className="grid two">
        <div className="hist-box" data-testid="as-classified-then">
          <div className="panel-title">AS CLASSIFIED THEN</div>
          {r.recorded ? (
            <>
              <div><b>{r.recorded.primary === 'EMPTY' ? 'No position' : RISK_LABEL[r.recorded.hullTemp]}</b> · {typeText(r.recorded)}</div>
              <div className="faint" style={{ fontSize: 12 }}>
                Recorded live by the hourly scan at block {r.recorded.block.toLocaleString('en-US')} ({when(r.recorded.at)}) under rules {r.recorded.rulesVersion}. The original result — never re-classified.
              </div>
            </>
          ) : (
            <div className="dim">Nothing recorded for this wallet at or before that block (recording hadn't started, or it held no position).</div>
          )}
        </div>
        <div className="hist-box" data-testid="using-current-rules">
          <div className="panel-title">USING CURRENT RULES ({RULES.RULES_VERSION})</div>
          {r.unreadable ? (
            <div className="banner red">UNAVAILABLE — neither venue could be read at that block ({r.tydro}). The RPC may not keep state that old (that needs an archive node). Nothing is guessed.</div>
          ) : (
            <>
              <div><b>{RISK_LABEL[r.pose.hullTemp]}</b> · {r.pose.primary ? TAG_LABEL[r.pose.primary] : NO_TYPE_LABEL}</div>
              <div className="tags" style={{ marginTop: 4 }}>{r.pose.tags.map((t) => <TagChip key={t} tag={t} />)}</div>
              <dl className="kv tight" style={{ marginTop: 6 }}>
                <dt>Tydro HF</dt><dd className="num">{r.tydro ? 'unreadable' : r.hf === null ? '—' : r.hf.toFixed(3)}</dd>
                <dt>Nado buffer</dt><dd className="num">{r.nado ? 'unreadable' : pct(r.buffer)}</dd>
              </dl>
              <div className="faint" style={{ fontSize: 12 }}>
                Reconstructed now, in your browser, from the chain at that block — not observed live then.
                {r.tydro ? ` Tydro couldn't be read: ${r.tydro}.` : ''}
                {r.nado ? ` Nado couldn't be read: ${r.nado}.` : ''}
              </div>
            </>
          )}
        </div>
      </div>
      {differs ? (
        <div className="banner" data-testid="past-differs">
          The two differ. {r.recorded!.rulesVersion !== RULES.RULES_VERSION ? `It was classified under rules ${r.recorded!.rulesVersion}; the current rules are ${RULES.RULES_VERSION}. ` : ''}
          The recorded result also comes from the hourly scan's own block ({r.recorded!.block.toLocaleString('en-US')}), which can differ from the block you picked. Both are shown; neither replaces the other.
        </div>
      ) : null}
    </div>
  );
}


/** This wallet's actual liquidations in the range (historical, from the ledger). */
function WalletLiquidations({ address, range, index }: { address: string; range: Range; index: HistoryIndex }) {
  const led = useLedger(range, index);
  if (!index.ledger) return <div className="faint" style={{ fontSize: 12 }} data-testid="wallet-liq">Liquidations: the ledger starts with the next hourly scan.</div>;
  if (led.status !== 'ok') return null;
  const mine = led.records.filter((r) => r.wallet === address.toLowerCase()).sort((a, b) => b.at - a.at);
  return (
    <div data-testid="wallet-liq">
      <div className="panel-title" style={{ marginBottom: 6 }}>Liquidations of this wallet in this range</div>
      {mine.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>When (UTC)</th><th>Venue</th><th>What</th><th>Size</th><th>AEGIS before</th></tr></thead>
            <tbody>
              {mine.map((r) => (
                <tr key={r.id}>
                  <td className="mono"><a href={`${INK_EXPLORER}/tx/${r.tx}`} target="_blank" rel="noreferrer">{when(r.at)}</a></td>
                  <td className="mono">{r.venue}{r.subaccountKind === 'isolated' ? ' · isolated' : ''}</td>
                  <td className="mono">{r.venue === 'tydro' ? `${r.collateral} seized · ${r.debt} repaid` : r.product}</td>
                  <td className="mono">{r.sizeBand ? SIZE_LABEL[r.sizeBand] : 'unavailable'}</td>
                  <td className="mono">{aegisBefore(r).text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="dim" style={{ fontSize: 12 }}>
          None recorded in this range{index.ledger.done ? '' : ' (older liquidations are still being added by the history scan)'}.
        </div>
      )}
    </div>
  );
}
