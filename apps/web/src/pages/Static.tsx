import { COPY } from '@aegis/glyphs';
import { CoverageShares, MixBar } from '../components/CensusBits';
import { WELL_ON, WELL_PREVIEW, useCensus } from '../lib/census';
import { verificationText } from '../lib/verification';
import { fmtAge } from '../lib/fmt';
import { useNow } from '../lib/hulls';
import { Panel } from '../components/bits';

export function CensusPage() {
  const census = useCensus();
  const now = useNow(5000);
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
        <>
          <Panel title="Position types" rail="var(--cyan)" testId="census-panel">
            <MixBar mix={census.snap.mix} label={COPY.censusFull} />
          </Panel>
          <div className="grid two">
            <Panel title="Coverage" rail="var(--slate)">
              <dl className="kv">
                <dt>wallets found</dt><dd className="num">{census.snap.counts.known.toLocaleString('en-US')}</dd>
                <dt>with a position</dt><dd className="num">{census.snap.counts.drawn.toLocaleString('en-US')}</dd>
                <dt>empty</dt><dd className="num">{census.snap.counts.empty.toLocaleString('en-US')}</dd>
                <dt>on Tydro</dt><dd className="num">{census.snap.counts.tydro.toLocaleString('en-US')}</dd>
                <dt>on Nado</dt><dd className="num">{census.snap.counts.nado.toLocaleString('en-US')}</dd>
                <dt>near liquidation</dt><dd className="num">{census.snap.counts.wounded.toLocaleString('en-US')}</dd>
                <dt>couldn't read</dt><dd className="num">{census.snap.counts.dark.toLocaleString('en-US')}</dd>
              </dl>
              <CoverageShares snap={census.snap} now={now} />
            </Panel>
            <Panel title="Last scan" rail="var(--slate)">
              <dl className="kv">
                <dt>block</dt><dd className="num">{census.snap.block.toLocaleString('en-US')}</dd>
                <dt>age</dt><dd className="mono">{fmtAge(Date.parse(census.snap.generatedAt), now)} ago</dd>
                <dt>type</dt><dd className="mono">{census.snap.sweep.kind === 'full' ? 'full re-read' : 'hourly'}{census.snap.sweep.complete === false ? ' (partial — continues next run)' : ''} · {census.snap.sweep.reread.toLocaleString('en-US')} wallets re-read · {census.snap.sweep.carried.toLocaleString('en-US')} kept from earlier · {Math.round(census.snap.sweep.ms / 1000)}s</dd>
                <dt>history</dt>
                <dd className="mono">
                  {census.snap.discovery.backfillComplete
                    ? 'complete — every Tydro and Nado wallet since launch'
                    : `backfilling — Tydro to ${census.snap.discovery.tydroScannedTo.toLocaleString('en-US')}, Nado to ${census.snap.discovery.nadoScannedTo.toLocaleString('en-US')} of ${census.snap.discovery.head.toLocaleString('en-US')}`}
                </dd>
                <dt>rules</dt><dd className="mono">{census.snap.rulesVersion}</dd>
              </dl>
            </Panel>
          </div>
          <Panel title="Limits" rail="var(--slate)">
            <ul className="dim" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
              <li>Counts wallets, not money. A $5 account and a $5M account each count once.</li>
              <li>Nado isolated-margin positions are found from every trade since launch.</li>
              <li>Wallets near danger, Tydro borrowers and anything that moved are re-read every hour, and live while the well is open. Quiet, healthy wallets are re-read in the weekly full scan.</li>
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
