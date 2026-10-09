import { Link } from 'react-router-dom';
import { Fragment } from 'react';
import { COPY } from '@aegis/glyphs';
import { Colony } from '../components/Colony';
import { useLiveWell } from '../lib/live';
import { WELL_ON, WELL_PREVIEW, useCensus } from '../lib/census';
import { verificationText } from '../lib/verification';
import { useNow } from '../lib/hulls';
import { Panel } from '../components/bits';
import { ENV } from '../lib/env';
import { useMe } from '../lib/account';

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
      <h2 className="page">Scan — every wallet Phrourax has found</h2>
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
  ['/protocol <on | off>', 'also Ink-wide events: oracle problems, parameter changes, Ink Stress Level changes, liquidation cascades, failed checks'],
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
          COMING SOON · BUILT AND TESTED — Telegram alerts are not accepting sign-ups yet. No bot is currently available to message.
        </div>
      )}
      <Panel title="What alerts will do" rail="var(--slate)">
        <p className="dim">You pick wallets in a private Telegram chat with the Phrourax bot. You get a message when one of them changes:</p>
        <ul className="dim">
          <li>risk level SAFE → WATCH → NEAR LIQUIDATION → LIQUIDATABLE, and back (a recovery must hold on consecutive readings before it&apos;s announced);</li>
          <li>your own lines: Tydro health factor below a number, Nado margin buffer below a percent (worst subaccount), or &ldquo;if ETH fell 20% this would be liquidated&rdquo;;</li>
          <li>the classification changes, a venue can&apos;t be read, or a reading is stale or partial — said plainly, never shown as current.</li>
          <li>a watched wallet is actually liquidated on-chain (always on, from the Liquidation Ledger).</li>
        </ul>
        <p className="dim">Prefer your own system? The same events will be available as signed <Link to="/developers">webhooks</Link>. Same readers, rules and scenario engine as the rest of Phrourax. The same alert isn&apos;t repeated inside an hour, and each chat has an hourly cap (the worst news always goes through).</p>
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
          <li>Phrourax never asks for a key, never connects to a wallet and cannot move funds. Private chats only.</li>
        </ul>
      </Panel>
    </div>
  );
}

const API_ENDPOINTS: Array<[string, string]> = [
  ['/status', 'network status: census block, time, sweep, counts'],
  ['/coverage', 'known wallets vs each protocol’s on-chain totals'],
  ['/stress', 'current Ink Stress Level and its inputs'],
  ['/stress/history', 'Ink Stress Level over time'],
  ['/pressure?dir=ETH&sign=down&pct=10&material=1k', 'aggregate scenario: wallet counts (1–4 suppressed)'],
  ['/wallets/{address}', 'one wallet’s classification and risk — no balances'],
  ['/wallets/{address}/history', 'its recorded changes'],
  ['/wallets/{address}/scenario?dir=ETH&pct=20', 'the level it would reach under a move (live, 6/min)'],
  ['/oracles · /oracles/events', 'Oracle Watch'],
  ['/changes', 'protocol parameter changes'],
  ['/liquidations · /cascades', 'the ledger (time-ordered) and cascade-1.0.0 groups'],
  ['/performance', 'warnings and forecasts vs what happened'],
  ['/carry', 'Yield and Carry (analysis only)'],
  ['/verification', 'automatic checks'],
  ['/events', 'Ink-wide event feed'],
];

export function DevelopersPage() {
  const me = useMe();
  const paywall = me.status === 'ok' && me.me.paywall === true;
  return (
    <div className="stack" data-testid="developers-page">
      <h2 className="page">Developers</h2>
      <Panel title="Public Risk API — /api/v1 (read-only)" rail="var(--cyan)">
        <p className="dim">
          The same readings as the site, as JSON. Every response carries its schema, rules / engine / data versions, source block, generated time, age, freshness, completeness, approximation and coverage, and the disclaimer. Full description:{' '}
          <a className="mono" href="/api/v1/openapi.json">/api/v1/openapi.json</a> (OpenAPI 3.1).
        </p>
        {paywall ? (
          <div className="banner" data-testid="dev-paid">
            Paid plans are on: <span className="mono">/status</span>, <span className="mono">/wallets/&#123;address&#125;</span>, <span className="mono">/performance</span> and{' '}
            <span className="mono">/verification</span> stay free; the rest need the <Link to="/pricing">Desk plan</Link> (signed in for now — API keys are coming).
          </div>
        ) : null}
        <pre className="mono dev-pre" data-testid="dev-example">{`# example (values change every scan)
curl https://phrourax.com/api/v1/stress

{ "schema": "phrourax-api-1",
  "data": { "level": "CALM", "confidence": "NORMAL", … },
  "meta": { "sourceBlock": 57725110, "freshness": "FRESH", "ageSeconds": 1840,
            "completeness": "COMPLETE", "rulesVersion": "v1.2.0", … } }`}</pre>
        <dl className="kv dev-kv">
          {API_ENDPOINTS.map(([p, d]) => (
            <Fragment key={p}>
              <dt className="mono alerts-cmd">{p}</dt>
              <dd className="dim">{d}</dd>
            </Fragment>
          ))}
        </dl>
      </Panel>
      <Panel title="Rules of use" rail="var(--slate)">
        <ul className="dim">
          <li>Rate limits per IP, per minute: aggregates 120 · one wallet 30 · live wallet scenario 6. Responses carry RateLimit headers; 429 carries Retry-After. Aggregates are cached for 60 s.</li>
          <li>Errors: <span className="mono">{'{ "error": { "code", "status", "message" } }'}</span> — codes are listed in the OpenAPI file.</li>
          <li>Privacy: no endpoint lists wallets or ranks them by closeness to liquidation; no balances, health factors or liquidation prices; small counts are suppressed. Ranges are bounded (90 days) and paged (100 per page).</li>
          <li>Versioning: fields are only added within v1. A breaking change becomes /api/v2, and v1 keeps working for at least 90 days after notice.</li>
          <li>Free, best effort, no uptime promise. Not advice. Phrourax cannot trade or move funds.</li>
        </ul>
      </Panel>
      <Panel title="Webhooks" rail="var(--slate)">
        <div className="banner" data-testid="webhooks-not-live">NOT LIVE YET — built and tested (signed, timestamped, retried, verified endpoints), but not switched on. Creating one answers NOT_ENABLED.</div>
      </Panel>
    </div>
  );
}

export function NotFound() {
  return <div className="banner">No such route.</div>;
}
