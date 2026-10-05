import { Suspense, lazy, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { CensusShip } from '@aegis/census';
import { COPY, RISK_LABEL, shipLiteFromPose } from '@aegis/glyphs';
import { ActivityTape, CensusStatusLine, LivePanel, MixBar, WoundedTape, blocksAgo, mixOf } from '../components/CensusBits';
import { PasteBar } from '../components/PasteBar';
import { Panel, TagChip } from '../components/bits';
import { Well, type WellShip } from '../components/Well';
import { WellFilters } from '../components/WellFilters';
import { ShipList } from '../components/Well';
import { hasWebGL } from '../lib/webgl';

// three.js + the sphere engine load only when the sphere is shown
const HullSphere = lazy(() => import('../components/sphere/HullSphere'));

type WellView = 'sphere' | '2d' | 'list';
const VIEWS: Array<[WellView, string]> = [
  ['sphere', 'SPHERE'],
  ['2d', '2D'],
  ['list', 'LIST'],
];
import { applyFilter, filterFromParams, filterToParams, type PoseKey, type WellFilter } from '../lib/wellFilter';
import { WELL_ON, WELL_PREVIEW, useCensus } from '../lib/census';
import { verificationText } from '../lib/verification';
import { useHullCache } from '../lib/hulls';
import { useLiveWell } from '../lib/live';
import { wellPhase } from '../lib/wellState';
import { useNow } from '../lib/hulls';
import { fmtAge } from '../lib/fmt';

export function Home() {
  const nav = useNavigate();
  const cache = useHullCache();
  const census = useCensus();
  const lw = useLiveWell(census, WELL_ON);
  const snap = census.status === 'ok' ? census.snap : null;
  const head = lw.stats.head ?? snap?.block ?? null;
  const now = useNow(60_000);
  const phase = wellPhase(census, now);
  const ready = phase.kind === 'ok' || phase.kind === 'empty';

  // the head moves every block; ships must not be rebuilt for that (18k objects → re-filter → re-seat), so the
  // "read N ago" line reads the head when a tooltip or row draws it
  const headRef = useRef(head);
  headRef.current = head;
  const ships: WellShip[] = useMemo(() => {
    const out = new Map<string, WellShip>();
    const fromCensus = (s: CensusShip): WellShip => ({
      address: s.address,
      primary: s.primary,
      tags: s.tags,
      hullTemp: s.hullTemp,
      band: s.band,
      href: `/hull/${s.address}`,
      meta: () => {
        const rb = lw.latest(s.address)?.readBlock ?? s.readBlock; // a re-read that changed nothing still freshens this line
        return `read ${blocksAgo(rb, headRef.current)}${snap && rb > snap.block ? ' · live' : ''}`;
      },
      flashAt: lw.flashes.get(s.address),
      venues: s.venues,
    });
    for (const s of lw.ships) if (s.primary !== 'EMPTY') out.set(s.address, fromCensus(s));
    // hulls this viewer opened: ringed, and their fresher hull-page reading wins
    for (const [addr, h] of cache) {
      if (h.pose.primary === 'EMPTY') continue;
      out.set(addr, { ...shipLiteFromPose(addr, h.pose), focused: true, href: `/hull/${addr}`, meta: () => 'opened by you · read live' });
    }
    return [...out.values()];
    // lw.ships is a new array only when a wallet's type, risk, size, venues or the snapshot changed (not on every re-read)
  }, [lw.ships, lw.flashes, cache, snap]);

  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => filterFromParams(params), [params]);
  // ?well=legacy keeps the WELL GLASS 2D plot for one release (so the sphere can be compared with it);
  // ?view=sphere|2d|list picks the view. No WebGL → the 2D plot.
  const legacy = params.get('well') === 'legacy';
  const glOk = useMemo(() => hasWebGL(), []);
  const viewParam = params.get('view');
  const asked: WellView | null = viewParam === 'sphere' || viewParam === '2d' || viewParam === 'list' ? viewParam : null;
  const view: WellView = asked === 'sphere' && !glOk ? '2d' : asked ?? (legacy || !glOk ? '2d' : 'sphere');
  const keep = () => ({ ...(legacy ? { well: 'legacy' } : {}), ...(asked ? { view: asked } : {}) });
  const setFilter = (f: WellFilter) => setParams({ ...filterToParams(f), ...keep() }, { replace: true });
  const setView = (v: WellView) => setParams({ ...filterToParams(filter), ...(legacy ? { well: 'legacy' } : {}), view: v }, { replace: true });
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

  const mix = useMemo(() => mixOf(lw.ships), [lw.ships]);
  const open = useCallback((href: string) => nav(href), [nav]);
  const sessionList = [...cache.entries()];

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="stack" style={{ gap: 6 }}>
        <h2 className="page">{COPY.oneLiner}</h2>
        <PasteBar autoFocus />
        <div className="faint mono" style={{ fontSize: 11 }}>
          Read-only. No connect required. Phrourax reads Tydro and Nado straight from the Ink chain and sorts each wallet into a position type.
        </div>
      </div>

      {!WELL_ON ? (
        <>
          <div className="banner red" data-testid="unverified-banner">
            WELL LOCKED — READINGS NOT YET VERIFIED. No real Ink address has yet been matched against the official Tydro and Nado apps.
            Wallet pages work; the well is not drawn until <code>pnpm prove &lt;address&gt;</code> passes.
          </div>
          <Panel title="Wallets read this session" rail="var(--slate)" right={<span className="mono">N={sessionList.length}</span>}>
            {sessionList.length === 0 ? (
              <div className="dim">{COPY.wellEmpty}</div>
            ) : (
              <div className="table-wrap">
                <table className="t" data-testid="session-list">
                  <thead>
                    <tr><th>Wallet</th><th>Position type</th><th>Risk</th></tr>
                  </thead>
                  <tbody>
                    {sessionList.map(([addr, h]) => (
                      <tr key={addr}>
                        <td className="mono"><Link to={`/hull/${addr}`}>{`${addr.slice(0, 6)}…${addr.slice(-4)}`}</Link></td>
                        <td><div className="tags">{h.pose.tags.length ? h.pose.tags.map((t) => <TagChip key={t} tag={t} />) : <TagChip tag={null} />}</div></td>
                        <td className="mono">{RISK_LABEL[h.pose.hullTemp]}</td>
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
              PREVIEW — real chain reads. {verificationText()}. Treat position types as provisional until both venues are verified.
              (Shown because this is a dev build or VITE_WELL_PREVIEW=1.)
            </div>
          ) : null}
          {phase.kind === 'unavailable' ? (
            <div className="banner red" data-testid="census-missing" role="alert">
              SCAN UNAVAILABLE — {phase.message}. Nothing is drawn rather than showing zeroes. Wallet pages still read live.
            </div>
          ) : null}
          {phase.kind === 'ok' && phase.lastGood && snap ? (
            <div className="banner" data-testid="census-last-good" role="status">
              LAST GOOD SCAN — loading a newer one failed ({phase.refreshError}). Showing the scan from block {snap.block.toLocaleString('en-US')}, {fmtAge(Date.parse(snap.generatedAt), now)} ago.
            </div>
          ) : null}

          <Panel title="The well" rail="var(--cyan)" right={<span className="mono">every Tydro + Nado wallet found on-chain</span>}>
            <div className="stack" style={{ gap: 12 }}>
              <CensusStatusLine snap={snap} stats={lw.stats} live={lw.live} onToggle={() => lw.setLive(!lw.live)} phase={phase} visible={lw.visible} />
              {phase.kind === 'loading' ? (
                <div className="well-wait" data-testid="well-loading" role="status" aria-live="polite">
                  LOADING LATEST SCAN…
                  <small>Counts and the well appear once the scan has loaded — nothing here is a zero.</small>
                </div>
              ) : null}
              {phase.kind === 'unavailable' ? (
                <div className="well-wait bad" data-testid="well-unavailable" role="status">
                  SCAN UNAVAILABLE
                  <small>The latest scan couldn't be loaded, so no wallet counts are shown. Paste an address above to read one wallet live.</small>
                </div>
              ) : null}
              {phase.kind === 'empty' ? <div className="banner cyan">{COPY.wellEmpty}</div> : null}
              {ready && ships.length > 0 ? <WellFilters filter={filter} onChange={setFilter} all={ships} shown={shown.length} counts={counts} /> : null}
              {ready && ships.length > 0 ? (
                <div className="view-switch" role="group" aria-label="Well view" data-testid="view-switch">
                  {VIEWS.map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      className={`sq-btn${view === v ? ' on' : ''}`}
                      aria-pressed={view === v}
                      disabled={v === 'sphere' && !glOk}
                      title={v === 'sphere' && !glOk ? 'This browser has no WebGL — the sphere needs it' : undefined}
                      onClick={() => setView(v)}
                    >
                      {label}
                    </button>
                  ))}
                  {!glOk ? <span className="faint mono" style={{ fontSize: 10, marginLeft: 8 }}>NO WEBGL · 2D WELL</span> : null}
                </div>
              ) : null}
              {ready && ships.length > 0 && view === 'sphere' ? (
                <Suspense fallback={<div className="wg hs-loading-box">LOADING THE SPHERE…</div>}>
                  <HullSphere ships={shown} found={filter.find || null} resetKey={resetKey} onOpen={open} />
                </Suspense>
              ) : null}
              {ready && ships.length > 0 && view === '2d' ? <Well ships={shown} found={filter.find || null} resetKey={resetKey} onOpen={open} /> : null}
              {ready && ships.length > 0 && view === 'list' ? <ShipList ships={shown} onOpen={(href) => nav(href)} defaultOpen /> : null}
              {ready ? (
                <MixBar mix={mix} label={COPY.censusFull} />
              ) : (
                <div className="mix-wait" data-testid="mix-wait">POSITION-TYPE MIX · {phase.kind === 'loading' ? 'WAITING FOR THE SCAN' : 'UNAVAILABLE'}</div>
              )}
            </div>
          </Panel>

          <div className="grid two">
            <Panel title="Near liquidation" rail="var(--red)">
              <WoundedTape ships={lw.ships} head={head} ready={ready} notReady={phase.kind === 'loading' ? 'Loading the latest scan…' : 'Scan unavailable — no counts shown.'} />
            </Panel>
            <Panel title="Activity" rail="var(--cyan)">
              <ActivityTape changes={lw.changes} />
            </Panel>
          </div>

          <Panel title="Live updates" rail="var(--ink-faint)" right={<span className="mono">on-page diagnostics</span>}>
            <LivePanel stats={lw.stats} />
          </Panel>
        </>
      )}

      <Panel title="How the well is built" rail="var(--slate)">
        <ul className="dim" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
          <li>Every wallet here was found from public on-chain events (Tydro token transfers, Nado deposits and trades). Nothing is scraped or bought.</li>
          <li>An hourly scan reads them all and publishes the result. While this page is open, your browser watches every new block and re-reads any wallet that acts, plus the ones near danger.</li>
          <li>Each wallet shows how old its reading is. A reading that fails is never filled in — the last good one is kept and its age shows.</li>
          <li>Size is shown in <strong>ranges</strong> (e.g. $1k–10k), never balances. The near-liquidation list is ordered by when a wallet was first seen near liquidation, never by how close it is.</li>
          <li>Made-up test wallets live on the <Link to="/calibration">Checks</Link> page and never appear here.</li>
        </ul>
      </Panel>
    </div>
  );
}
