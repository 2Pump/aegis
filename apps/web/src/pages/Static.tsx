import { COPY } from '@aegis/glyphs';
import { Panel } from '../components/bits';
import { RulesContent } from '../components/RulesContent';

export function RulesPage() {
  return (
    <div className="stack">
      <h2 className="page">Rules — how a pose is decided</h2>
      <Panel title="Classifier" rail="var(--cyan)">
        <RulesContent />
      </Panel>
    </div>
  );
}

export function CensusPage() {
  return (
    <div className="stack">
      <h2 className="page">Census</h2>
      <Panel title="Phase 2 — not built" rail="var(--slate)">
        <p className="dim">Aggregate pose mix of the readable sample. Held until Phase 1 is demoed and signed off.</p>
        <p className="mono faint" style={{ fontSize: 12 }}>{COPY.census}</p>
      </Panel>
    </div>
  );
}

export function WatchPage() {
  return (
    <div className="stack">
      <h2 className="page">Watch</h2>
      <Panel title="Phase 3 — not built" rail="var(--slate)">
        <p className="dim">Telegram pings (/watch 0x…, /hf 1.4, /wounded). No writes to venues, ever. Held until Phases 1–2 ship.</p>
      </Panel>
    </div>
  );
}

export function NotFound() {
  return <div className="banner">No such route.</div>;
}
