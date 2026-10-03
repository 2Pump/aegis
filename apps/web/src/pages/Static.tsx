import { COPY } from '@aegis/glyphs';
import { Colony } from '../components/Colony';
import { useLiveWell } from '../lib/live';
import { WELL_ON, WELL_PREVIEW, useCensus } from '../lib/census';
import { verificationText } from '../lib/verification';
import { useNow } from '../lib/hulls';
import { Panel } from '../components/bits';

export function CensusPage() {
  const census = useCensus();
  const now = useNow(5000);
  // the live layer only drops specks into the dish when a wallet's type changes; it never adds wallets
  const lw = useLiveWell(census, WELL_ON);
  if (!WELL_ON) {
    return (
      <div className="stack">
        <h2 className="page">Scan</h2>
        <div className="banner red">Locked with the well until the readings are verified against the official apps.</div>
      </div>
    );
  }
  return (
    <div className="stack">
      <h2 className="page">Scan — every wallet AEGIS has found</h2>
      {WELL_PREVIEW ? <div className="banner">PREVIEW — {verificationText()}.</div> : null}
      {census.status === 'loading' ? <div className="dim">Loading the latest scan…</div> : null}
      {census.status === 'missing' || census.status === 'error' ? <div className="banner">{census.message}</div> : null}
      {census.status === 'ok' ? (
        <Colony snap={census.snap} now={now} changes={lw.changes} />
      ) : null}
    </div>
  );
}

export function WatchPage() {
  return (
    <div className="stack">
      <h2 className="page">Alerts</h2>
      <Panel title="Phase 3 — not built" rail="var(--slate)">
        <p className="dim">Telegram alerts for wallets you choose (for example, when one moves near liquidation). No writes to venues, ever. Held until Phases 1–2 ship.</p>
      </Panel>
    </div>
  );
}

export function NotFound() {
  return <div className="banner">No such route.</div>;
}
