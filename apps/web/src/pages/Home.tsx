import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { COPY } from '@aegis/glyphs';
import { PasteBar } from '../components/PasteBar';
import { Panel, TagChip } from '../components/bits';
import { Well, type WellShip } from '../components/Well';
import { useHullCache } from '../lib/hulls';
import { PROOFS, VERIFIED } from '../lib/verification';

export function Home() {
  const nav = useNavigate();
  const cache = useHullCache();
  // Live ships only. Fixtures never enter the well — they live on /calibration.
  const ships: WellShip[] = useMemo(
    () => [...cache.entries()].map(([addr, h]) => ({ address: addr, pose: h.pose, focused: true, href: `/hull/${addr}` })),
    [cache],
  );

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="stack" style={{ gap: 6 }}>
        <h2 className="page">{COPY.oneLiner}</h2>
        <PasteBar autoFocus />
        <div className="faint mono" style={{ fontSize: 11 }}>
          Read-only. No connect required. AEGIS reads Tydro and Nado straight from the Ink chain and classifies the pose.
        </div>
      </div>

      {!VERIFIED ? (
        <>
          <div className="banner red" data-testid="unverified-banner">
            WELL LOCKED — SENSORS UNVERIFIED. No real Ink address has yet been matched against the official Tydro and Nado UIs.
            Hull pages work; the well is not drawn until <code>pnpm prove &lt;address&gt;</code> passes.
          </div>
          <Panel title="Hulls read this session" rail="var(--slate)" right={<span className="mono">N={ships.length} · not the whole chain</span>}>
            {ships.length === 0 ? (
              <div className="dim">{COPY.wellEmpty}</div>
            ) : (
              <div className="table-wrap">
                <table className="t" data-testid="ship-list">
                  <thead>
                    <tr><th>Hull</th><th>Tags</th><th>Temp</th></tr>
                  </thead>
                  <tbody>
                    {ships.map((s) => (
                      <tr key={s.address}>
                        <td className="mono"><Link to={s.href}>{`${s.address.slice(0, 6)}…${s.address.slice(-4)}`}</Link></td>
                        <td><div className="tags">{s.pose.tags.length ? s.pose.tags.map((t) => <TagChip key={t} tag={t} />) : <TagChip tag={null} />}</div></td>
                        <td className="mono">{s.pose.hullTemp}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      ) : (
        <Panel
          title="The well"
          rail="var(--cyan)"
          right={<span className="mono">sample N={ships.length} live · not the whole chain · sensors proven {PROOFS.at(-1)?.at.slice(0, 10) ?? ''}</span>}
        >
          {ships.length === 0 ? <div className="banner cyan" style={{ marginBottom: 12 }}>{COPY.wellEmpty}</div> : null}
          <Well ships={ships} onOpen={(href) => nav(href)} />
        </Panel>
      )}

      <Panel title="Sample policy" rail="var(--slate)">
        <ul className="dim" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
          <li>Ships = addresses <em>you</em> opened in this browser tab. Nothing is scraped. No synthetic ships are ever drawn here.</li>
          <li>The six synthetic calibration books live on <Link to="/calibration">/calibration</Link>, clearly labeled.</li>
          <li>Curated seed list (<code>/fixtures/seeds.json</code>) is empty on purpose. Wounded tape, census and event-derived watchlist are Phase 2.</li>
          <li>Size is shown as <strong>bands</strong>, never exact balances. Exact figures only on a hull page you open.</li>
        </ul>
      </Panel>
    </div>
  );
}
