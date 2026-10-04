import { Fragment } from 'react';
import { COPY } from '@aegis/glyphs';
import { Colony } from '../components/Colony';
import { useLiveWell } from '../lib/live';
import { WELL_ON, WELL_PREVIEW, useCensus } from '../lib/census';
import { verificationText } from '../lib/verification';
import { useNow } from '../lib/hulls';
import { Panel } from '../components/bits';
import { ENV } from '../lib/env';

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

const ALERT_COMMANDS: Array<[string, string]> = [
  ['/watch <address> [tydro|nado]', 'watch a wallet'],
  ['/unwatch <address>', 'stop watching it'],
  ['/list', 'what you watch'],
  ['/status [address]', 'read now'],
  ['/hf <address> <1.0–5 | off>', 'alert when Tydro HF falls below'],
  ['/buffer <address> <1–90 | off>', 'alert when the worst Nado margin buffer (%) falls below'],
  ['/scenario <address> <BTC|ETH|…> <±pct | off>', 'alert when that move would liquidate it'],
  ['/pause · /resume', 'hold or restart your alerts'],
  ['/delete', 'erase your chat and everything stored for it'],
];

export function WatchPage() {
  const bot = ENV.alertsBot;
  return (
    <div className="stack alerts-page" data-testid="alerts-page" data-live={bot ? 'yes' : 'no'}>
      <h2 className="page">Alerts</h2>
      {bot ? (
        <Panel title="Telegram alerts" rail="var(--cyan)">
          <p>
            Message <a href={`https://t.me/${bot}`} target="_blank" rel="noreferrer" className="mono">@{bot}</a> on Telegram and send <span className="mono">/start</span>.
          </p>
          <p className="dim">Checked on a schedule, not instantly — a message can arrive minutes after the chain moved. Don&apos;t rely on it as your only warning.</p>
        </Panel>
      ) : (
        <div className="banner" data-testid="alerts-unavailable" role="status">
          NOT LIVE YET — Telegram alerts are built and tested, but not switched on. There is no bot to message and nothing to sign up for.
        </div>
      )}
      <Panel title="What alerts will do" rail="var(--slate)">
        <p className="dim">You pick wallets in a private Telegram chat with the AEGIS bot. You get a message when one of them changes:</p>
        <ul className="dim">
          <li>risk level SAFE → WATCH → NEAR LIQUIDATION → LIQUIDATABLE, and back (a recovery must hold on consecutive readings before it&apos;s announced);</li>
          <li>your own lines: Tydro health factor below a number, Nado margin buffer below a percent (worst subaccount), or &ldquo;if ETH fell 20% this would be liquidated&rdquo;;</li>
          <li>the classification changes, a venue can&apos;t be read, or a reading is stale or partial — said plainly, never shown as current.</li>
        </ul>
        <p className="dim">Same readers, rules and scenario engine as the rest of AEGIS. The same alert isn&apos;t repeated inside an hour, and each chat has an hourly cap (the worst news always goes through).</p>
      </Panel>
      <Panel title="Commands" rail="var(--slate)">
        <dl className="kv">
          {ALERT_COMMANDS.map(([c, d]) => (
            <Fragment key={c}>
              <dt className="mono alerts-cmd">{c}</dt>
              <dd className="dim">{d}</dd>
            </Fragment>
          ))}
        </dl>
      </Panel>
      <Panel title="What is stored, and what isn't" rail="var(--slate)">
        <ul className="dim">
          <li>Stored: your Telegram chat id and the wallets and lines you set — encrypted at rest. Nothing else. <span className="mono">/delete</span> erases it at once.</li>
          <li>Messages carry the risk level, HF / margin buffer, data age and block — never balances or position sizes.</li>
          <li>AEGIS never asks for a key, never connects to a wallet and cannot move funds. Private chats only.</li>
        </ul>
      </Panel>
    </div>
  );
}

export function NotFound() {
  return <div className="banner">No such route.</div>;
}
