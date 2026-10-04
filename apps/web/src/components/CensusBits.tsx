import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { sharePct, type CensusShip, type CensusSnapshot, type LiveChange, type LiveStats } from '@aegis/census';
import { COPY, NO_TYPE_LABEL, RISK_LABEL, SIZE_LABEL, TAG_LABEL, tagColor } from '@aegis/glyphs';
import { RULES, type Tag } from '@aegis/pose';
import { fmtAge } from '../lib/fmt';
import { useNow } from '../lib/hulls';
import { TagChip } from './bits';
import { SensorLog } from './SensorLog';

/** Ink makes ~1 block per second; block counts are exact, times derived from them are approximate (~). */
export function blocksAgo(block: number, head: number | null): string {
  if (!head) return `block ${block.toLocaleString('en-US')}`;
  const d = Math.max(0, head - block);
  if (d < 90) return `${d} blocks ago (~${d}s)`;
  if (d < 5400) return `${d.toLocaleString('en-US')} blocks ago (~${Math.round(d / 60)}m)`;
  return `${d.toLocaleString('en-US')} blocks ago (~${(d / 3600).toFixed(1)}h)`;
}

/** "~42s ago" / "~12m ago" / "~3.1h ago" from block distance (Ink ≈ 1 block/s). */
export function sinceText(block: number, head: number | null): string {
  if (!head) return `block ${block.toLocaleString('en-US')}`;
  const d = Math.max(0, head - block);
  if (d < 90) return `~${d}s ago`;
  if (d < 5400) return `~${Math.round(d / 60)}m ago`;
  return `~${(d / 3600).toFixed(1)}h ago`;
}

const MIX_ORDER: Array<Tag | 'NONE'> = ['CARRY', 'EQUITY-MARGIN', 'NAKED', 'KBTC-CORE', 'LOCKED', 'STABLE-BALLAST', 'LEVERED', 'HOLD', 'WOUNDED', 'DARK', 'NONE'];

export function mixOf(ships: readonly CensusShip[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const s of ships) {
    if (s.primary === 'EMPTY') continue;
    const k = s.primary ?? 'NONE';
    m[k] = (m[k] ?? 0) + 1;
  }
  return m;
}

export function MixBar({ mix, label }: { mix: Record<string, number>; label: string }) {
  const total = Object.values(mix).reduce((a, b) => a + b, 0);
  const parts = MIX_ORDER.filter((k) => mix[k]).map((k) => ({ k, n: mix[k]!, color: k === 'NONE' ? '#6B7280' : tagColor(k as Tag) }));
  return (
    <div data-testid="mixbar">
      <div className="mixbar" role="img" aria-label={`Position types: ${parts.map((p) => `${p.k === 'NONE' ? NO_TYPE_LABEL : TAG_LABEL[p.k as Tag]} ${p.n}`).join(', ')}`}>
        {parts.map((p) => (
          <span key={p.k} style={{ width: `${(p.n / Math.max(total, 1)) * 100}%`, background: p.k === 'DARK' ? 'repeating-linear-gradient(45deg,#374151 0 4px,#1f2937 4px 8px)' : p.color }} />
        ))}
      </div>
      <div className="mix-legend">
        {parts.map((p) => (
          <span key={p.k}>
            <i style={{ background: p.color }} />
            {p.k === 'NONE' ? NO_TYPE_LABEL : TAG_LABEL[p.k as Tag]} {p.n.toLocaleString('en-US')} ({((p.n / Math.max(total, 1)) * 100).toFixed(1)}%)
          </span>
        ))}
      </div>
      <div className="faint mono" style={{ fontSize: 11, marginTop: 6 }}>{label}</div>
    </div>
  );
}

/** Telemetry strip: what the well is showing, how old it is, and whether the live layer is watching. */
export function CensusStatusLine({ snap, stats, live, onToggle }: { snap: CensusSnapshot | null; stats: LiveStats; live: boolean; onToggle: () => void }) {
  // the clock ticks here, not in Home: a once-a-second re-render of the whole page would re-walk 18k wallets
  const now = useNow(1000);
  const cell = (k: string, v: React.ReactNode, style?: React.CSSProperties) => (
    <div className="tele-cell" style={style}>
      {k} <b>{v}</b>
    </div>
  );
  return (
    <div className="tele" data-testid="census-status">
      {snap ? (
        <>
          {cell('LAST SCAN', snap.block.toLocaleString('en-US'))}
          {cell('AGE', fmtAge(Date.parse(snap.generatedAt), now).toUpperCase())}
          {cell('TYPE', snap.sweep.kind === 'full' ? (snap.sweep.complete === false ? 'FULL · PARTIAL' : 'FULL') : 'HOURLY')}
          {cell('WALLETS', snap.counts.drawn.toLocaleString('en-US'))}
          {cell('FOUND', snap.counts.known.toLocaleString('en-US'))}
          {cell('RULES', snap.rulesVersion.toUpperCase())}
          {!snap.discovery.backfillComplete ? <div className="tele-cell amber">HISTORY BACKFILL IN PROGRESS</div> : null}
        </>
      ) : (
        <div className="tele-cell">NO SCAN YET · LIVE UPDATES ONLY</div>
      )}
      <div className={`tele-live${stats.running ? '' : ' off'}`}>
        <i aria-hidden />
        <span>
          {stats.running ? 'LIVE' : 'PAUSED'}
          {stats.cursor ? <> <b>{stats.cursor.toLocaleString('en-US')}</b></> : null}
          {stats.lagBlocks !== null ? <> · LAG <b>{stats.lagBlocks}</b></> : null}
        </span>
        <button className="sq-btn" onClick={onToggle} data-testid="live-toggle" aria-pressed={!live}>
          {live ? 'PAUSE' : 'RESUME'}
        </button>
      </div>
    </div>
  );
}

/**
 * How much of each protocol the known wallets add up to, measured against the protocols' own on-chain totals
 * on the last full sweep. Shares only — the snapshot carries no dollar figures.
 */
export function CoverageShares({ snap, now }: { snap: CensusSnapshot; now: number }) {
  const c = snap.coverage;
  if (!c) {
    return <div className="faint" style={{ fontSize: 12, marginTop: 10 }} data-testid="coverage-shares">How much of each protocol the found wallets cover: measured on the next full scan (every 3 hours).</div>;
  }
  const row = (label: string, x: number | null) => (
    <>
      <dt>{label}</dt>
      <dd className="num" style={{ color: x !== null && x < 0.9 ? 'var(--amber)' : undefined }}>{sharePct(x)}</dd>
    </>
  );
  return (
    <div style={{ marginTop: 10 }} data-testid="coverage-shares">
      <div className="faint" style={{ fontSize: 12, marginBottom: 4 }}>
        How much of each protocol's own on-chain totals the found wallets add up to · full scan at block {c.block.toLocaleString('en-US')} ({fmtAge(Date.parse(c.at), now)} ago)
        {c.darkWallets ? ` · ${c.darkWallets} unreadable` : ''}
      </div>
      <dl className="kv">
        {row('Tydro supplied', c.share.tydroSupply)}
        {row('Tydro borrowed', c.share.tydroDebt)}
        {row('Nado deposits', c.share.nadoDeposits)}
        {c.share.nadoDepositsNadoOwn ? row("Nado deposits held by Nado's own vault and accounts (not wallets)", c.share.nadoDepositsNadoOwn) : null}
        {row('Nado open longs', c.share.nadoOpenInterestLongs)}
        {row('Nado open shorts', c.share.nadoOpenInterestShorts)}
      </dl>
    </div>
  );
}

/** Which rule tripped — thresholds only, never the wallet's actual number (no liquidation math on the tape). */
export function woundText(s: CensusShip): string {
  const t = s.correlatedLoop ? `Tydro health factor < ${RULES.WOUNDED_HF_CORRELATED} (same-asset loop)` : `Tydro health factor < ${RULES.WOUNDED_HF}`;
  const n = s.correlatedNado
    ? `Nado margin buffer < ${Math.round(RULES.NADO_BUFFER_CRIT_CORRELATED * 100)}% (same-asset loop)`
    : `Nado margin buffer < ${Math.round(RULES.NADO_BUFFER_CRIT * 100)}%`;
  if (s.wound.tydro && s.wound.nado) return `${t} + ${n}`;
  if (s.wound.tydro) return t;
  if (s.wound.nado) return n;
  return 'venue shown after the next hourly scan';
}

export function WoundedTape({ ships, head }: { ships: readonly CensusShip[]; head: number | null }) {
  // ordered by when they were first seen wounded — never by how close to liquidation
  const all = useMemo(
    () => ships.filter((s) => s.woundedSince !== null && s.primary !== 'EMPTY').sort((a, b) => (b.woundedSince ?? 0) - (a.woundedSince ?? 0)),
    [ships],
  );
  const asMain = useMemo(() => all.filter((s) => s.primary === 'WOUNDED').length, [all]);
  const wounded = all.slice(0, 8);
  return (
    <div data-testid="wounded-tape">
      <div className="panel-title" style={{ marginBottom: 6 }}>{COPY.woundedTape}</div>
      {wounded.length === 0 ? (
        <div className="dim">No wallets near liquidation right now.</div>
      ) : (
        <>
          <div className="faint" style={{ fontSize: 12, marginBottom: 8 }} data-testid="wounded-explain">
            {all.length} {all.length === 1 ? 'wallet is' : 'wallets are'} near liquidation · for {asMain} it's the only type that applies (the mix bar counts only those). The badge is each wallet's position type. Newest first
            {all.length > wounded.length ? ` · showing ${wounded.length}` : ''}.
          </div>
          <ul className="tape">
            {wounded.map((s) => (
              <li key={s.address}>
                <span className="when">{sinceText(s.woundedSince!, head)}</span>
                <Link className="mono" to={`/hull/${s.address}`}>{s.address.slice(0, 6)}…{s.address.slice(-4)}</Link>
                <TagChip tag={s.primary} />
                <span className="faint">{woundText(s)}</span>
                <span className="faint">size {SIZE_LABEL[s.band]}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

const KIND_TEXT: Record<LiveChange['kind'], string> = { new: 'new wallet', flip: 'type changed', temp: 'risk changed', wounded: 'now near liquidation', healed: 'recovered' };

export function ActivityTape({ changes }: { changes: readonly LiveChange[] }) {
  const now = useNow(1000);
  return (
    <div data-testid="activity-tape">
      <div className="panel-title" style={{ marginBottom: 6 }}>Live changes</div>
      {changes.length === 0 ? (
        <div className="dim">Watching the chain. Changes appear here within seconds.</div>
      ) : (
        <ul className="tape">
          {changes.slice(0, 10).map((c) => (
            <li key={`${c.address}-${c.at}`}>
              <span className="when">{fmtAge(c.at, now)} ago</span>
              <Link className="mono" to={`/hull/${c.address}`}>{c.address.slice(0, 6)}…{c.address.slice(-4)}</Link>
              <span>{KIND_TEXT[c.kind]}</span>
              {c.from ? <span className="faint">{c.from.primary ? TAG_LABEL[c.from.primary] : NO_TYPE_LABEL} · {RISK_LABEL[c.from.hullTemp]} →</span> : null}
              <TagChip tag={c.to.primary} />
              <span className="faint">{RISK_LABEL[c.to.hullTemp]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LivePanel({ stats }: { stats: LiveStats }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="statline">
        <span>latest block <b>{stats.head?.toLocaleString('en-US') ?? '—'}</b></span>
        <span>watched up to <b>{stats.cursor?.toLocaleString('en-US') ?? '—'}</b></span>
        <span>events <b>{stats.logsSeen}</b></span>
        <span>wallets touched <b>{stats.touched}</b></span>
        <span>re-reads <b>{stats.reads}</b></span>
        <span>queue <b>{stats.queue}</b></span>
        <span>errors <b style={{ color: stats.errors ? 'var(--red)' : undefined }}>{stats.errors}</b></span>
        {stats.gap ? <span style={{ color: 'var(--amber)' }}>skipped ahead (the last scan was old)</span> : null}
      </div>
      {stats.lastError ? <div className="banner red">{stats.lastError}</div> : null}
      <SensorLog scope="live" />
    </div>
  );
}
