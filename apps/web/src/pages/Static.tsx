import { Link } from 'react-router-dom';
import { Fragment } from 'react';
import { COPY } from '@aegis/glyphs';
import { Colony } from '../components/Colony';
import { useLiveWell } from '../lib/live';
import { WELL_ON, WELL_PREVIEW, useCensus } from '../lib/census';
import { verificationText } from '../lib/verification';
import { useNow } from '../lib/hulls';
import { Panel } from '../components/bits';
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
            <span className="mono">/verification</span> stay free; the rest need the <Link to="/pricing">Desk plan</Link>. Make an API key on your <Link to="/account">Account</Link> page and send it as{' '}
            <span className="mono">Authorization: Bearer phx_…</span>.
          </div>
        ) : null}
        <pre className="mono dev-pre" data-testid="dev-example">{`# example (values change every scan)
curl -H "Authorization: Bearer phx_…" https://phrourax.com/api/v1/stress

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
          <li>Rate limits per minute — per API key when you send one, otherwise per IP: aggregates 120 · one wallet 30 · live wallet scenario 6. Responses carry RateLimit headers; 429 carries Retry-After. Aggregates are cached for 60 s.</li>
          <li>API keys (Desk): up to 5 per account, made and revoked on the Account page, shown once. A revoked key stops working within about 30 seconds; an unknown or revoked key answers 401, a key whose Desk plan has ended answers 402. Keep keys server-side — never in a web page or public code.</li>
          <li>Errors: <span className="mono">{'{ "error": { "code", "status", "message" } }'}</span> — codes are listed in the OpenAPI file.</li>
          <li>Privacy: no endpoint lists wallets or ranks them by closeness to liquidation; no balances, health factors or liquidation prices; small counts are suppressed. Ranges are bounded (90 days) and paged (100 per page).</li>
          <li>Versioning: fields are only added within v1. A breaking change becomes /api/v2, and v1 keeps working for at least 90 days after notice.</li>
          <li>Free, best effort, no uptime promise. Not advice. Phrourax cannot trade or move funds.</li>
        </ul>
      </Panel>
      <Panel title="Webhooks" rail="var(--slate)">
        {me.status === 'ok' && me.me.webhooks ? (
          <div className="stack" style={{ gap: 8 }} data-testid="webhooks-live">
            <p className="dim" style={{ margin: 0 }}>
              Signed HTTPS POSTs of Phrourax events to an endpoint you own — wallet risk changes for up to 10 wallets per endpoint, liquidations, oracle problems, parameter changes, Ink Stress Level, cascades, failed checks. Desk: up to 5 endpoints per account. Delivered every ~10 minutes, retried with backoff, never balances.
            </p>
            <pre className="mono dev-pre">{`curl -X POST https://phrourax.com/api/v1/webhooks \
  -H "Authorization: Bearer phx_…" -H "Content-Type: application/json" \
  -d '{"url":"https://you.example/hook","events":["wallet.risk_changed","oracle.depeg"],"wallets":["0x…"]}'

→ 201 { "id": "wh_…", "secret": "whsec_…", "token": "whtok_…" }   # shown once`}</pre>
            <p className="dim" style={{ margin: 0 }}>
              Verify every delivery with the <span className="mono">Phrourax-Signature</span> header (HMAC-SHA256 of <span className="mono">t.body</span> with your secret). Manage it with its token:{' '}
              <span className="mono">GET / PATCH / DELETE /webhooks/&#123;id&#125;</span>, <span className="mono">POST …/rotate</span>, <span className="mono">POST …/test</span>. If the Desk plan ends, its webhooks pause; renew, then PATCH <span className="mono">{'{"status":"active"}'}</span>.
            </p>
          </div>
        ) : (
          <div className="banner" data-testid="webhooks-not-live">NOT LIVE YET — built and tested (signed, timestamped, retried, verified endpoints), but not switched on. Creating one answers NOT_ENABLED.</div>
        )}
      </Panel>
    </div>
  );
}

export function NotFound() {
  return <div className="banner">No such route.</div>;
}
