/** /pricing — the plans (docs/PAYWALL.md, docs/BILLING.md). Paid in crypto on NOWPayments' page; nothing renews by itself. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BRAND, PLANS } from '@aegis/glyphs';
import { PLAN_LABEL, fmtDay, startCheckout, useMe } from '../lib/account';

type Key = 'free' | 'pro' | 'desk';

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
          <ul className="plan-list">
            {p.features.map((f) => <li key={f}>{f}</li>)}
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
      <div className="note-text" style={{ maxWidth: 820 }}>
        You pay on NOWPayments' page from your own wallet — {BRAND.display} never connects to it. Each {PLANS.PERIOD_DAYS}-day period is paid separately: nothing renews or
        charges by itself, and we email a renewal link before it ends. A subscription buys information only: {BRAND.display} is read-only, never trades, and is not financial
        advice. <Link to="/terms">Terms and refunds</Link>.
        {current ? <> You're signed in on the <b>{PLAN_LABEL[current]}</b> plan.</> : null}
      </div>
    </div>
  );
}
