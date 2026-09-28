import { Link } from 'react-router-dom';
import type { CensusShip, CensusSnapshot, LiveChange, LiveStats } from '@aegis/census';
import { COPY, tagColor } from '@aegis/glyphs';
import { RULES, type Tag } from '@aegis/pose';
import { fmtAge } from '../lib/fmt';
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

const MIX_ORDER: Array<Tag | 'NONE'> = ['CARRY', 'EQUITY-MARGIN', 'NAKED', 'KBTC-CORE', 'LOCKED', 'STABLE-BALLAST', 'LEVERED', 'WOUNDED', 'DARK', 'NONE'];

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
      <div className="mixbar" role="img" aria-label={`Pose mix: ${parts.map((p) => `${p.k} ${p.n}`).join(', ')}`}>
        {parts.map((p) => (
          <span key={p.k} style={{ width: `${(p.n / Math.max(total, 1)) * 100}%`, background: p.k === 'DARK' ? 'repeating-linear-gradient(45deg,#374151 0 4px,#1f2937 4px 8px)' : p.color }} />
        ))}
      </div>
      <div className="mix-legend">
        {parts.map((p) => (
          <span key={p.k}>
            <i style={{ background: p.color }} />
            {p.k === 'NONE' ? 'NO RULE' : p.k} {p.n.toLocaleString('en-US')} ({((p.n / Math.max(total, 1)) * 100).toFixed(1)}%)
          </span>
        ))}
      </div>
      <div className="faint mono" style={{ fontSize: 11, marginTop: 6 }}>{label}</div>
    </div>
  );
}

export function CensusStatusLine({ snap, stats, now, live, onToggle }: { snap: CensusSnapshot | null; stats: LiveStats; now: number; live: boolean; onToggle: () => void }) {
  return (
    <div className="statline" data-testid="census-status">
      {snap ? (
        <>
          <span>census <b>{snap.counts.drawn.toLocaleString('en-US')}</b> ships of <b>{snap.counts.known.toLocaleString('en-US')}</b> known wallets</span>
          <span>snapshot block <b>{snap.block.toLocaleString('en-US')}</b> · {fmtAge(Date.parse(snap.generatedAt), now)} ago · {snap.sweep.kind}</span>
          {!snap.discovery.backfillComplete ? <span style={{ color: 'var(--amber)' }}>history backfill in progress</span> : null}
        </>
      ) : (
        <span>no census snapshot — live layer only</span>
      )}
      <span>
        <i className={`live-dot${stats.running ? '' : ' off'}`} />
        {stats.running ? 'LIVE' : 'PAUSED'} {stats.cursor ? <>at block <b>{stats.cursor.toLocaleString('en-US')}</b></> : null}
        {stats.lagBlocks !== null ? ` · lag ${stats.lagBlocks}` : ''}
      </span>
      <button className="pill-btn" style={{ padding: '3px 10px', fontSize: 10 }} onClick={onToggle} data-testid="live-toggle">
        {live ? 'Pause live' : 'Resume live'}
      </button>
    </div>
  );
}

/** Which rule tripped — thresholds only, never the wallet's actual number (no liquidation math on the tape). */
export function woundText(s: CensusShip): string {
  const t = `Tydro HF < ${RULES.WOUNDED_HF}`;
  const n = `Nado buffer < ${Math.round(RULES.NADO_BUFFER_CRIT * 100)}%`;
  if (s.wound.tydro && s.wound.nado) return `${t} + ${n}`;
  if (s.wound.tydro) return t;
  if (s.wound.nado) return n;
  return 'venue shown after next hourly run';
}

export function WoundedTape({ ships, head }: { ships: readonly CensusShip[]; head: number | null }) {
  // ordered by when they were first seen wounded — never by how close to liquidation
  const all = ships.filter((s) => s.woundedSince !== null && s.primary !== 'EMPTY').sort((a, b) => (b.woundedSince ?? 0) - (a.woundedSince ?? 0));
  const asMain = all.filter((s) => s.primary === 'WOUNDED').length;
  const wounded = all.slice(0, 8);
  return (
    <div data-testid="wounded-tape">
      <div className="panel-title" style={{ marginBottom: 6 }}>{COPY.woundedTape}</div>
      {wounded.length === 0 ? (
        <div className="dim">No wounded books right now.</div>
      ) : (
        <>
          <div className="faint" style={{ fontSize: 12, marginBottom: 8 }} data-testid="wounded-explain">
            {all.length} books tripped the WOUNDED rule · {asMain} have it as their main pose (the mix bar counts only those). Badge = main pose. Newest first
            {all.length > wounded.length ? ` · showing ${wounded.length}` : ''}.
          </div>
          <ul className="tape">
            {wounded.map((s) => (
              <li key={s.address}>
                <span className="when">{sinceText(s.woundedSince!, head)}</span>
                <Link className="mono" to={`/hull/${s.address}`}>{s.address.slice(0, 6)}…{s.address.slice(-4)}</Link>
                <TagChip tag={s.primary} />
                <span className="faint">{woundText(s)}</span>
                <span className="faint">band {s.band}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

const KIND_TEXT: Record<LiveChange['kind'], string> = { new: 'new ship', flip: 'pose flip', temp: 'temp change', wounded: 'went WOUNDED', healed: 'recovered' };

export function ActivityTape({ changes, now }: { changes: readonly LiveChange[]; now: number }) {
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
              {c.from ? <span className="faint">{c.from.primary ?? '—'}/{c.from.hullTemp} →</span> : null}
              <TagChip tag={c.to.primary} />
              <span className="faint">{c.to.hullTemp}</span>
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
        <span>head <b>{stats.head?.toLocaleString('en-US') ?? '—'}</b></span>
        <span>scanned to <b>{stats.cursor?.toLocaleString('en-US') ?? '—'}</b></span>
        <span>events <b>{stats.logsSeen}</b></span>
        <span>wallets touched <b>{stats.touched}</b></span>
        <span>re-reads <b>{stats.reads}</b></span>
        <span>queue <b>{stats.queue}</b></span>
        <span>errors <b style={{ color: stats.errors ? 'var(--red)' : undefined }}>{stats.errors}</b></span>
        {stats.gap ? <span style={{ color: 'var(--amber)' }}>skipped ahead (snapshot was old)</span> : null}
      </div>
      {stats.lastError ? <div className="banner red">{stats.lastError}</div> : null}
      <SensorLog scope="live" />
    </div>
  );
}
