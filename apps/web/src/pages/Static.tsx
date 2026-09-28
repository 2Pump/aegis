import { COPY } from '@aegis/glyphs';
import { MixBar } from '../components/CensusBits';
import { WELL_ON, WELL_PREVIEW, useCensus } from '../lib/census';
import { fmtAge } from '../lib/fmt';
import { useNow } from '../lib/hulls';
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
  const census = useCensus();
  const now = useNow(5000);
  if (!WELL_ON) {
    return (
      <div className="stack">
        <h2 className="page">Census</h2>
        <div className="banner red">Locked with the well until sensors are verified against the official UIs.</div>
      </div>
    );
  }
  return (
    <div className="stack">
      <h2 className="page">Census</h2>
      {WELL_PREVIEW ? <div className="banner">PREVIEW — sensors not yet matched against app.tydro.com / app.nado.xyz.</div> : null}
      {census.status === 'loading' ? <div className="dim">Loading census…</div> : null}
      {census.status === 'missing' || census.status === 'error' ? <div className="banner">{census.message}</div> : null}
      {census.status === 'ok' ? (
        <>
          <Panel title="Pose mix" rail="var(--cyan)" testId="census-panel">
            <MixBar mix={census.snap.mix} label={COPY.censusFull} />
          </Panel>
          <div className="grid two">
            <Panel title="Coverage" rail="var(--slate)">
              <dl className="kv">
                <dt>wallets known</dt><dd className="num">{census.snap.counts.known.toLocaleString('en-US')}</dd>
                <dt>drawn (non-empty)</dt><dd className="num">{census.snap.counts.drawn.toLocaleString('en-US')}</dd>
                <dt>empty</dt><dd className="num">{census.snap.counts.empty.toLocaleString('en-US')}</dd>
                <dt>on Tydro</dt><dd className="num">{census.snap.counts.tydro.toLocaleString('en-US')}</dd>
                <dt>on Nado</dt><dd className="num">{census.snap.counts.nado.toLocaleString('en-US')}</dd>
                <dt>wounded</dt><dd className="num">{census.snap.counts.wounded.toLocaleString('en-US')}</dd>
                <dt>dark</dt><dd className="num">{census.snap.counts.dark.toLocaleString('en-US')}</dd>
              </dl>
            </Panel>
            <Panel title="Snapshot" rail="var(--slate)">
              <dl className="kv">
                <dt>block</dt><dd className="num">{census.snap.block.toLocaleString('en-US')}</dd>
                <dt>generated</dt><dd className="mono">{fmtAge(Date.parse(census.snap.generatedAt), now)} ago</dd>
                <dt>sweep</dt><dd className="mono">{census.snap.sweep.kind} · {census.snap.sweep.reread.toLocaleString('en-US')} re-read · {census.snap.sweep.carried.toLocaleString('en-US')} carried · {Math.round(census.snap.sweep.ms / 1000)}s</dd>
                <dt>history</dt>
                <dd className="mono">
                  {census.snap.discovery.backfillComplete
                    ? 'complete — every Tydro and Nado account since launch'
                    : `backfilling — Tydro to ${census.snap.discovery.tydroScannedTo.toLocaleString('en-US')}, Nado to ${census.snap.discovery.nadoScannedTo.toLocaleString('en-US')} of ${census.snap.discovery.head.toLocaleString('en-US')}`}
                </dd>
                <dt>rules</dt><dd className="mono">{census.snap.rulesVersion}</dd>
              </dl>
            </Panel>
          </div>
          <Panel title="Limits" rail="var(--slate)">
            <ul className="dim" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
              <li>Counts wallets, not money. A $5 account and a $5M account each count once.</li>
              <li>Nado isolated subaccounts are found from recent trades; old, quiet isolated positions may be missing until they trade.</li>
              <li>Quiet, healthy Nado accounts are re-read weekly in full; everything else hourly, and live while the well is open.</li>
            </ul>
          </Panel>
        </>
      ) : null}
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
