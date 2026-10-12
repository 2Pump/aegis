/** /pricing — the plans (docs/PAYWALL.md, docs/BILLING.md). Paid in crypto on NOWPayments' page; nothing renews by itself. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BRAND, PLANS } from '@aegis/glyphs';
import { PLAN_LABEL, fmtDay, startCheckout, useMe } from '../lib/account';

type Key = 'free' | 'pro' | 'desk';
type Cell = 'yes' | 'no' | 'soon' | string;

/** Who each plan is for — plain, no claims. */
const FOR: Record<Key, string> = {
  free: 'Checking an individual wallet.',
  pro: 'Active Ink users, researchers and anyone monitoring risk across the ecosystem.',
  desk: 'Developers, teams and automated integrations.',
};

/** The comparison. Truthful states only: what isn't open yet says so (Telegram alerts flip to INCLUDED when the server says they're live). */
const COMPARE: Array<[string, Cell, Cell, Cell]> = [
  ["A wallet's risk level and position types", 'yes', 'yes', 'yes'],
  ['Share links and preview cards', 'yes', 'yes', 'yes'],
  ['Public rules, Checks and track record', 'yes', 'yes', 'yes'],
  ['The Well — every wallet found, by type and risk', 'no', 'yes', 'yes'],
  ['Pressure — defined market moves across Ink', 'no', 'yes', 'yes'],
  ['Intel — history, liquidations, oracles, changes, carry', 'no', 'yes', 'yes'],
  ['Scan — wallets found and coverage', 'no', 'yes', 'yes'],
  ['Full wallet positions and exposure', 'no', 'yes', 'yes'],
  ['Wallet history', 'no', 'yes', 'yes'],
  ['Wallet stress test', 'no', 'yes', 'yes'],
  ['Telegram alerts', 'no', 'soon:up to 10 wallets', 'soon:up to 100 wallets'],
  ['API — free endpoints (/status, /wallets/{address}, /performance, /verification)', 'yes', 'yes', 'yes'],
  ['API — every other endpoint', 'no', 'no', 'yes:with your API keys (up to 5)'],
  ['Webhooks', 'no', 'no', 'soon'],
];

function CellView({ c }: { c: Cell }) {
  const [kind, note] = c.includes(':') ? [c.slice(0, c.indexOf(':')), c.slice(c.indexOf(':') + 1)] : [c, ''];
  const label = kind === 'yes' ? 'INCLUDED' : kind === 'soon' ? 'COMING SOON' : 'NOT INCLUDED';
  return (
    <span className={`cmp cmp-${kind}`}>
      <span className="cmp-mark" aria-hidden>{kind === 'yes' ? '●' : kind === 'soon' ? '◌' : '—'}</span> {label}
      {note ? <span className="cmp-note"> · {note}</span> : null}
    </span>
  );
}

export function PricingPage() {
  const me = useMe();
  const m = me.status === 'ok' ? me.me : null;
  const current: Key | null = m?.signedIn ? m.access : null;
  const [busy, setBusy] = useState<Key | null>(null);
  const [error, setError] = useState('');
  const buy = async (k: 'pro' | 'desk') => {
    setBusy(k);
    setError('');
    const msg = await startCheckout(k);
    if (msg) {
      setError(msg);
      setBusy(null);
    }
  };
  const action = (k: Key) => {
    if (k === 'free') return <Link className="pill-btn" to="/">Check a wallet</Link>;
    if (!m) return null;
    if (!m.configured) return <span className="faint mono" style={{ fontSize: 11 }}>Accounts open soon.</span>;
    if (!m.signedIn) return <Link className={`pill-btn ${k === 'pro' ? 'solid' : 'amber'}`} to="/signin?next=/pricing" data-testid={`subscribe-${k}`}>Sign in to subscribe</Link>;
    if (m.comp) return current === k ? <span className="mono plan-current" data-testid={`current-${k}`}>Your plan · complimentary</span> : null;
    const mine = current === k;
    const other = current !== 'free' && current !== null && !mine;
    return (
      <span className="stack" style={{ gap: 6 }}>
        {mine ? <span className="mono plan-current" data-testid={`current-${k}`}>Your plan{m.paidUntil ? ` · paid to ${fmtDay(m.paidUntil)}` : ''}</span> : null}
        {m.billing ? (
          <button className={`pill-btn ${k === 'pro' ? 'solid' : 'amber'}`} disabled={busy !== null} onClick={() => void buy(k)} data-testid={`subscribe-${k}`}>
            {busy === k ? 'Opening the payment page…' : mine ? 'Add 30 days — pay in crypto' : 'Subscribe — pay in crypto'}
          </button>
        ) : (
          <>
            <button className={`pill-btn ${k === 'pro' ? 'solid' : 'amber'}`} disabled data-testid={`subscribe-${k}`}>Subscribe — pay in crypto</button>
            <span className="faint mono" style={{ fontSize: 11 }}>Payments open soon.</span>
          </>
        )}
        {mine ? <span className="faint mono" style={{ fontSize: 11 }}>Added to the end of your current period.</span> : null}
        {other && m.billing ? <span className="faint mono" style={{ fontSize: 11 }}>Switching plans starts a fresh {PLANS.PERIOD_DAYS} days of {PLANS[k as 'pro' | 'desk'].name} now.</span> : null}
      </span>
    );
  };
  const card = (k: Key, rail: string) => {
    const p = PLANS[k];
    return (
      <section className={`panel plan${current === k ? ' plan-on' : ''}`} style={{ ['--rail' as string]: rail }} data-testid={`plan-${k}`}>
        <div className="rail" aria-hidden />
        <div className="body">
          <h3 className="panel-title">{p.name}</h3>
          <div className="plan-price">
            ${p.usd}
            {p.usd ? <small> USDC / {PLANS.PERIOD_DAYS} days</small> : null}
          </div>
          <div className="dim" style={{ fontSize: 13 }}>{p.blurb}</div>
          <div className="plan-for" data-testid={`for-${k}`}>For: {FOR[k]}</div>
          <ul className="plan-list">
            {p.features.map((f) => (m?.webhooks ? f.replace(' (when they open)', '') : f)).map((f) => <li key={f}>{f}</li>)}
          </ul>
          {action(k)}
        </div>
      </section>
    );
  };
  return (
    <div className="stack" data-testid="pricing-page">
      <h2 className="page">Plans</h2>
      {error ? <div className="banner red" role="alert" data-testid="checkout-error">{error}</div> : null}
      <div className="grid three plans">
        {card('free', 'var(--ink-faint)')}
        {card('pro', 'var(--cyan)')}
        {card('desk', 'var(--amber)')}
      </div>
      <section className="panel" style={{ ['--rail' as string]: 'var(--slate)' }} data-testid="plan-compare" aria-labelledby="compare-title">
        <div className="rail" aria-hidden />
        <div className="body">
          <h3 className="panel-title" id="compare-title">Compare plans</h3>
          <div className="table-wrap">
            <table className="t compare-t">
              <thead>
                <tr><th scope="col">What you get</th><th scope="col">Free</th><th scope="col">Pro · ${PLANS.pro.usd}</th><th scope="col">Desk · ${PLANS.desk.usd}</th></tr>
              </thead>
              <tbody>
                {COMPARE.map((r): typeof r => (m?.alerts && r[0] === 'Telegram alerts' ? [r[0], 'no', 'yes:up to 10 wallets', 'yes:up to 100 wallets'] : m?.webhooks && r[0] === 'Webhooks' ? [r[0], 'no', 'no', 'yes:up to 5 endpoints'] : r)).map(([what, f, p, d]) => (
                  <tr key={what}>
                    <th scope="row">{what}</th>
                    <td><CellView c={f} /></td>
                    <td><CellView c={p} /></td>
                    <td><CellView c={d} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="panel" style={{ ['--rail' as string]: 'var(--cyan)' }} data-testid="plan-proof" aria-labelledby="proof-title">
        <div className="rail" aria-hidden />
        <div className="body">
          <h3 className="panel-title" id="proof-title">Look before you pay</h3>
          <div className="proof-grid">
            <Link to="/fixture/carry" className="proof" data-testid="demo-wallet-link">
              <b>Explore a demo wallet</b>
              <span>The full wallet page on a made-up test wallet — hand-written values, not a real account.</span>
            </Link>
            <Link to="/calibration" className="proof">
              <b>View public Checks</b>
              <span>Every automatic check of the readings against the official sources, passes and failures alike.</span>
            </Link>
            <Link to="/calibration" className="proof">
              <b>Read the public track record</b>
              <span>Warnings against real liquidations, with the denominators and the cases too few to judge.</span>
            </Link>
            <Link to="/developers" className="proof">
              <b>View the API documentation</b>
              <span>Every endpoint, its fields and its limits (OpenAPI 3.1).</span>
            </Link>
          </div>
        </div>
      </section>

      <div className="note-text" style={{ maxWidth: 820 }}>
        Paid in crypto through NOWPayments: you pay on their page from your own wallet — {BRAND.display} never connects to it. Each period lasts {PLANS.PERIOD_DAYS} days and is paid separately:
        no automatic renewal, nothing charges by itself, and we email a renewal link before it ends. A subscription buys information only: {BRAND.display} is read-only, never trades, and is not financial
        advice. <Link to="/terms">Terms and refunds</Link>.
        {current ? <> You're signed in on the <b>{PLAN_LABEL[current]}</b> plan.</> : null}
      </div>
    </div>
  );
}
