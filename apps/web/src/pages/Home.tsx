import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { CensusShip } from '@aegis/census';
import { COPY, shipLiteFromPose } from '@aegis/glyphs';
import { ActivityTape, CensusStatusLine, LivePanel, MixBar, WoundedTape, blocksAgo, mixOf } from '../components/CensusBits';
import { PasteBar } from '../components/PasteBar';
import { Panel, TagChip } from '../components/bits';
import { Well, type WellShip } from '../components/Well';
import { WellFilters } from '../components/WellFilters';
import { WellLegacy } from '../components/WellLegacy';
import { applyFilter, filterFromParams, filterToParams, type PoseKey, type WellFilter } from '../lib/wellFilter';
import { WELL_ON, WELL_PREVIEW, useCensus } from '../lib/census';
import { verificationText } from '../lib/verification';
import { useHullCache, useNow } from '../lib/hulls';
import { useLiveWell } from '../lib/live';

export function Home() {
  const nav = useNavigate();
  const cache = useHullCache();
  const census = useCensus();
  const lw = useLiveWell(census, WELL_ON);
  const now = useNow(1000);
  const snap = census.status === 'ok' ? census.snap : null;
  const head = lw.stats.head ?? snap?.block ?? null;

  const ships: WellShip[] = useMemo(() => {
    const out = new Map<string, WellShip>();
    const fromCensus = (s: CensusShip): WellShip => ({
      address: s.address,
      primary: s.primary,
      tags: s.tags,
      hullTemp: s.hullTemp,
      band: s.band,
      href: `/hull/${s.address}`,
      meta: `read ${blocksAgo(s.readBlock, head)}${snap && s.readBlock > snap.block ? ' · live' : ''}`,
      flashAt: lw.flashes.get(s.address),
      venues: s.venues,
    });
    for (const s of lw.ships) if (s.primary !== 'EMPTY') out.set(s.address, fromCensus(s));
    // hulls this viewer opened: ringed, and their fresher hull-page reading wins
    for (const [addr, h] of cache) {
      if (h.pose.primary === 'EMPTY') continue;
      out.set(addr, { ...shipLiteFromPose(addr, h.pose), focused: true, href: `/hull/${addr}`, meta: 'opened by you · live hull read' });
    }
    return [...out.values()];
    // lw.stats.reads changes whenever the live layer updates a ship
  }, [lw.ships, lw.flashes, lw.stats.reads, cache, head, snap]);

  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => filterFromParams(params), [params]);
  // ?well=legacy keeps the pre-WELL GLASS well for one release, so the two can be diffed
  const legacy = params.get('well') === 'legacy';
  const setFilter = (f: WellFilter) => setParams({ ...filterToParams(f), ...(legacy ? { well: 'legacy' } : {}) }, { replace: true });
  const resetKey = useMemo(() => JSON.stringify({ ...filter, find: '' }), [filter]);
  const counts = useMemo(() => {
    const m = new Map<PoseKey, number>();
    for (const s of ships) m.set(s.primary ?? 'NONE', (m.get(s.primary ?? 'NONE') ?? 0) + 1);
    return m;
  }, [ships]);
  const shown = useMemo(() => {
    const f = applyFilter(ships, filter);
    // the ship you searched for is always drawn, even if a filter would hide it
    if (filter.find && !f.some((s) => s.address === filter.find)) {
      const hit = ships.find((s) => s.address === filter.find);
      if (hit) f.push(hit);
    }
    return f;
  }, [ships, filter]);

  const sessionList = [...cache.entries()];

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="stack" style={{ gap: 6 }}>
        <h2 className="page">{COPY.oneLiner}</h2>
        <PasteBar autoFocus />
        <div className="faint mono" style={{ fontSize: 11 }}>
          Read-only. No connect required. AEGIS reads Tydro and Nado straight from the Ink chain and classifies the pose.
        </div>
      </div>

      {!WELL_ON ? (
        <>
          <div className="banner red" data-testid="unverified-banner">
            WELL LOCKED — SENSORS UNVERIFIED. No real Ink address has yet been matched against the official Tydro and Nado UIs.
            Hull pages work; the well is not drawn until <code>pnpm prove &lt;address&gt;</code> passes.
          </div>
          <Panel title="Hulls read this session" rail="var(--slate)" right={<span className="mono">N={sessionList.length}</span>}>
            {sessionList.length === 0 ? (
              <div className="dim">{COPY.wellEmpty}</div>
            ) : (
              <div className="table-wrap">
                <table className="t" data-testid="session-list">
                  <thead>
                    <tr><th>Hull</th><th>Tags</th><th>Temp</th></tr>
                  </thead>
                  <tbody>
                    {sessionList.map(([addr, h]) => (
                      <tr key={addr}>
                        <td className="mono"><Link to={`/hull/${addr}`}>{`${addr.slice(0, 6)}…${addr.slice(-4)}`}</Link></td>
                        <td><div className="tags">{h.pose.tags.length ? h.pose.tags.map((t) => <TagChip key={t} tag={t} />) : <TagChip tag={null} />}</div></td>
                        <td className="mono">{h.pose.hullTemp}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      ) : (
        <>
          {WELL_PREVIEW ? (
            <div className="banner" data-testid="preview-banner">
              PREVIEW — real chain reads. {verificationText()}. Treat poses as provisional until both venues are verified.
              (Shown because this is a dev build or VITE_WELL_PREVIEW=1.)
            </div>
          ) : null}
          {census.status === 'missing' || census.status === 'error' ? (
            <div className="banner" data-testid="census-missing">{census.message}</div>
          ) : null}

          <Panel title="The well" rail="var(--cyan)" right={<span className="mono">every Tydro + Nado account found on-chain</span>}>
            <div className="stack" style={{ gap: 12 }}>
              <CensusStatusLine snap={snap} stats={lw.stats} now={now} live={lw.live} onToggle={() => lw.setLive(!lw.live)} />
              {census.status === 'loading' ? <div className="dim">Loading census…</div> : null}
              {ships.length === 0 && census.status !== 'loading' ? <div className="banner cyan">{COPY.wellEmpty}</div> : null}
              {ships.length > 0 ? <WellFilters filter={filter} onChange={setFilter} all={ships} shown={shown.length} counts={counts} /> : null}
              {ships.length > 0 ? (
                legacy ? (
                  <WellLegacy ships={shown} found={filter.find || null} onOpen={(href) => nav(href)} />
                ) : (
                  <Well ships={shown} found={filter.find || null} resetKey={resetKey} onOpen={(href) => nav(href)} />
                )
              ) : null}
              <MixBar mix={mixOf(lw.ships)} label={COPY.censusFull} />
            </div>
          </Panel>

          <div className="grid two">
            <Panel title="Wounded" rail="var(--red)">
              <WoundedTape ships={lw.ships} head={head} />
            </Panel>
            <Panel title="Activity" rail="var(--cyan)">
              <ActivityTape changes={lw.changes} now={now} />
            </Panel>
          </div>

          <Panel title="Live layer" rail="var(--ink-faint)" right={<span className="mono">on-page diagnostics</span>}>
            <LivePanel stats={lw.stats} />
          </Panel>
        </>
      )}

      <Panel title="How the well is built" rail="var(--slate)">
        <ul className="dim" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
          <li>Every wallet here was found from public on-chain events (Tydro token transfers, Nado deposits and trades). Nothing is scraped or bought.</li>
          <li>An hourly job reads them all and publishes a snapshot. While this page is open, your browser watches every new block and re-reads any wallet that acts, plus the ones near danger.</li>
          <li>Each ship shows how old its reading is. A reading that fails is never filled in — the last good one is kept and its age shows.</li>
          <li>Size is shown as <strong>bands</strong>, never balances. The wounded list is ordered by when a book was first seen wounded, never by how close it is to liquidation.</li>
          <li>Synthetic calibration books live on <Link to="/calibration">/calibration</Link> and never appear here.</li>
        </ul>
      </Panel>
    </div>
  );
}
