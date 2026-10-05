import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TAG_COLORS } from '@aegis/pose';
import { NO_TYPE_LABEL, NO_TYPE_MEANING, RISK_LABEL, SIZE_LABEL, TAG_LABEL, TAG_MEANING, primaryTypeLabel, NEAR_STATE_LONG, NEAR_EXPLAIN, NEAR_SOLE_LABEL, NEAR_STATE_LABEL } from '@aegis/glyphs';
import { POSE_CHIPS, isFilterActive, type MinBand, type PoseKey, type VenueFilter, type WellFilter } from '../lib/wellFilter';
import { TagChip } from './bits';
import type { WellShip } from './Well';

const VENUES: Array<[VenueFilter, string]> = [
  ['all', 'All venues'],
  ['tydro', 'Tydro'],
  ['nado', 'Nado'],
  ['both', 'Both'],
];
const MINS: Array<[MinBand, string]> = [
  ['all', 'Any size'],
  ['1k', '≥ $1k'],
  ['10k', '≥ $10k'],
  ['100k', '≥ $100k'],
];

/**
 * Filters + "find my ship" for a well of thousands. Everything lives in the URL, so a filtered view can be shared.
 * Size filters use the public BANDS only — the well never knows a balance.
 */
export function WellFilters({
  filter,
  onChange,
  all,
  shown,
  counts,
}: {
  filter: WellFilter;
  onChange: (f: WellFilter) => void;
  all: readonly WellShip[];
  shown: number;
  counts: Map<PoseKey, number>;
}) {
  const [findText, setFindText] = useState(filter.find);
  const [findErr, setFindErr] = useState<string | null>(null);
  const togglePose = (p: PoseKey) =>
    onChange({ ...filter, poses: filter.poses.includes(p) ? filter.poses.filter((x) => x !== p) : [...filter.poses, p] });

  const submitFind = (e: React.FormEvent) => {
    e.preventDefault();
    const a = findText.trim();
    if (!a) return onChange({ ...filter, find: '' });
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return setFindErr('That is not an Ink address (0x + 40 hex characters).');
    setFindErr(null);
    onChange({ ...filter, find: a.toLowerCase() });
  };

  const found = filter.find ? all.find((s) => s.address === filter.find) : undefined;
  // every ship near liquidation, whatever its main pose (the chip above counts only main-pose WOUNDED)
  const woundedCount = all.reduce((n, s) => n + (s.tags.includes('WOUNDED') ? 1 : 0), 0);

  return (
    <div className="stack well-filters" style={{ gap: 8 }} data-testid="well-filters">
      <div className="chips" role="group" aria-label="Filter by position type">
        {POSE_CHIPS.map((p) => {
          const on = filter.poses.includes(p);
          const color = p === 'NONE' ? '#6B7280' : TAG_COLORS[p] ?? '#9CA3AF';
          return (
            <button
              key={p}
              type="button"
              className={`chip-btn${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => togglePose(p)}
              title={p === 'NONE' ? NO_TYPE_MEANING : TAG_MEANING[p]}
              style={{ ['--chip' as string]: color }}
            >
              <i style={{ background: p === 'DARK' ? 'transparent' : color, border: p === 'DARK' ? '1px solid #9CA3AF' : undefined }} />
              {primaryTypeLabel(p)}
              <span className="faint"> {(counts.get(p) ?? 0).toLocaleString('en-US')}</span>
            </button>
          );
        })}
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select aria-label="Venue" className="sel" value={filter.venue} onChange={(e) => onChange({ ...filter, venue: e.target.value as VenueFilter })}>
          {VENUES.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <select aria-label="Minimum size band" className="sel" value={filter.min} onChange={(e) => onChange({ ...filter, min: e.target.value as MinBand })}>
          {MINS.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <label className="toggle" title={`${NEAR_STATE_LONG}, whatever their position type. ${NEAR_EXPLAIN}`}>
          <input
            type="checkbox"
            checked={filter.woundedOnly}
            onChange={(e) => onChange({ ...filter, woundedOnly: e.target.checked })}
            aria-label={`Show only ${NEAR_STATE_LONG.toLowerCase()}: ${woundedCount.toLocaleString('en-US')}`}
          />
          only current risk state: near liquidation <span className="faint">({woundedCount.toLocaleString('en-US')})</span>
        </label>
        <form className="find" onSubmit={submitFind}>
          <input
            aria-label="Find a wallet by address"
            placeholder="Find wallet — 0x…"
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            spellCheck={false}
          />
          <button className="pill-btn" type="submit">Find</button>
        </form>
        {isFilterActive(filter) ? (
          <button
            className="pill-btn"
            type="button"
            onClick={() => {
              setFindText('');
              setFindErr(null);
              onChange({ poses: [], venue: 'all', min: 'all', woundedOnly: false, find: '' });
            }}
          >
            Clear
          </button>
        ) : null}
        <span className="mono dim" style={{ fontSize: 12 }} data-testid="well-shown">
          showing {shown.toLocaleString('en-US')} of {all.length.toLocaleString('en-US')} wallets
        </span>
      </div>
      <div className="note-text" data-testid="near-explain">
        Two near-liquidation figures: <b>{NEAR_SOLE_LABEL.toLowerCase()}</b> ({(counts.get('WOUNDED') ?? 0).toLocaleString('en-US')}, a position-type chip above) and{' '}
        <b>{NEAR_STATE_LABEL.toLowerCase()}</b> ({woundedCount.toLocaleString('en-US')}, the checkbox). {NEAR_EXPLAIN}
      </div>
      {findErr ? <div className="banner" style={{ padding: '6px 10px' }}>{findErr}</div> : null}
      {filter.find && !found ? (
        <div className="banner cyan" style={{ padding: '6px 10px' }} data-testid="find-missing">
          {filter.find.slice(0, 6)}…{filter.find.slice(-4)} isn’t in the well (no Tydro or Nado position found in the last scan, or it’s empty).{' '}
          <Link to={`/hull/${filter.find}`}>Read this wallet live →</Link>
        </div>
      ) : null}
      {found ? (
        <div className="found-card" data-testid="find-card">
          <span className="mono">{found.address.slice(0, 6)}…{found.address.slice(-4)}</span>
          <TagChip tag={found.primary} />
          {found.tags.includes('WOUNDED') && found.primary !== 'WOUNDED' ? <TagChip tag="WOUNDED" /> : null}
          <span className="faint">risk {RISK_LABEL[found.hullTemp]} · size {SIZE_LABEL[found.band]}{found.meta ? ` · ${found.meta()}` : ''}</span>
          <Link to={found.href}>Open wallet →</Link>
        </div>
      ) : null}
    </div>
  );
}
