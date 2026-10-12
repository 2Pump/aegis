/**
 * /terms — Terms of Service, payments and refunds, and privacy, in plain language.
 * A starting draft written for the owner to review (docs/BILLING.md); it is not legal advice. Dated so changes show.
 */
import { Link } from 'react-router-dom';
import { BRAND, PLANS } from '@aegis/glyphs';
import { Panel } from '../components/bits';

export const TERMS_UPDATED = '12 October 2026';
const CONTACT = 'phrourax@gmail.com';

export function TermsPage() {
  const d = BRAND.display;
  return (
    <div className="stack terms" data-testid="terms-page">
      <h2 className="page">Terms, payments and privacy</h2>
      <div className="faint mono" style={{ fontSize: 11 }}>Last updated {TERMS_UPDATED}. Questions: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.</div>

      <Panel title="1 · What Phrourax is" rail="var(--cyan)">
        <ul>
          <li>{d} reads public data from the Ink blockchain (Tydro and Nado) and shows it with its own classifications, risk levels and analysis.</li>
          <li><b>It is read-only.</b> It never connects to your wallet, never asks for keys or a seed phrase, never signs anything and cannot move funds or trade.</li>
          <li><b>It is not financial, investment, legal or tax advice</b>, and nothing on it is a recommendation to do anything. You make your own decisions.</li>
          <li>Readings can be late, incomplete or wrong — a chain or data source can fail, and classifications follow published <Link to={{ search: '?rules=1' }}>rules</Link> that can't capture every situation. Don't rely on {d} alone for anything that matters.</li>
        </ul>
      </Panel>

      <Panel title="2 · Accounts" rail="var(--slate)">
        <ul>
          <li>You sign in with an emailed link. Keep access to your email secure — whoever can read it can sign in as you.</li>
          <li>One person per account. Don't share your account or resell what {d} shows; quoting and linking with credit is fine.</li>
          <li>Don't try to get around the paywall, overload the service, or scrape it beyond the API's published limits. We may suspend accounts that do.</li>
          <li><b>API keys</b> (Desk) act as your account. Keep them on your own servers, never in a web page or public code. If one leaks, revoke it on the Account page — it stops working within about a minute. You're responsible for what's done with your keys.</li>
        </ul>
      </Panel>

      <Panel title="2a · Alerts and webhooks" rail="var(--slate)" testId="terms-alerts">
        <ul>
          <li>Telegram alerts (Pro and Desk) and webhooks (Desk) are a convenience, not a guarantee. Wallets are checked about every 10 minutes, so a message can arrive after the chain has already moved, and a message can be delayed or not arrive at all (Telegram, your endpoint or our scheduler can fail). <b>Don't rely on them as your only warning.</b></li>
          <li>Alerts and webhooks carry risk levels, health-factor and margin-buffer readings, and public events — never balances or position sizes.</li>
          <li>When your plan ends, alerts stop (we tell your Telegram chat once) and webhooks are paused. Your wallets and settings are kept, and start again when you renew.</li>
          <li>Webhooks are signed; checking the signature on your side is your responsibility.</li>
        </ul>
      </Panel>

      <Panel title="3 · Plans, payment and renewals" rail="var(--amber)">
        <ul>
          <li>Plans are sold in {PLANS.PERIOD_DAYS}-day periods: {PLANS.pro.name} ${PLANS.pro.usd}, {PLANS.desk.name} ${PLANS.desk.usd} (US dollars, paid in crypto).</li>
          <li>Payment is handled by NOWPayments on their own page. You pay from your own wallet; {d} never sees or touches it. Network fees are yours.</li>
          <li><b>Nothing renews or charges by itself.</b> We email a reminder before a period ends; you choose whether to pay again.</li>
          <li>Paying again for the same plan adds {PLANS.PERIOD_DAYS} days to the end of your current period. Switching to a different plan starts a fresh {PLANS.PERIOD_DAYS} days of the new plan from the moment it's paid.</li>
          <li>A plan starts when the payment is confirmed on-chain (usually minutes).</li>
          <li>We may change prices for future periods; a period you've paid for keeps its price.</li>
        </ul>
      </Panel>

      <Panel title="4 · Refunds" rail="var(--amber)" testId="refunds">
        <ul>
          <li>Because crypto payments can't be reversed by us, a paid period is <b>not refundable</b> once it has started — with these exceptions:</li>
          <li><b>Paid twice by mistake</b> (two payments for one checkout, or a payment for a plan you already had to the same date): email us within 14 days and we'll refund the duplicate to the address you send, less network fees, or add the time — your choice.</li>
          <li><b>Overpaid:</b> anything above the plan price is refunded on request, less network fees.</li>
          <li><b>Underpaid</b> (NOWPayments shows "partially paid"): the plan doesn't start. Complete the payment on NOWPayments' page, or email us for a refund of what arrived, less network fees.</li>
          <li><b>Our outage:</b> if {d} is unavailable for more than 72 hours in a row during your period, we add the lost days to your plan.</li>
        </ul>
      </Panel>

      <Panel title="5 · Privacy" rail="var(--slate)" testId="terms-privacy">
        <ul>
          <li>We store your email address, your plan and its dates, and the record of your payments (date, plan, amount, the payment provider's reference).</li>
          <li><b>Wallets you only look at</b> on the site are read from the public chain in your browser and aren't stored; "My wallet" is saved in your browser only.</li>
          <li><b>If you use alerts:</b> the wallet addresses you choose to watch, the lines you set, and your Telegram chat id (stored encrypted). Unlinking Telegram removes the chat id at once.</li>
          <li><b>If you use the API or webhooks:</b> a fingerprint of each API key (never the key itself), and for each webhook its address, the wallets and events you chose, its signing secret (stored encrypted) and a short delivery log.</li>
          <li>Services we use: Vercel (hosting and storage), Upstash (account store), Resend (emails), NOWPayments (payments — their own privacy terms apply on their page), Telegram (alert messages, if you link it) and GitHub (runs the scheduled checks).</li>
          <li>No advertising, no selling of data, no tracking cookies. The only cookie is the one that keeps you signed in.</li>
          <li>To delete your account and everything stored with it (alerts, API keys, webhooks), email us from the account's address.</li>
        </ul>
      </Panel>

      <Panel title="6 · The usual limits" rail="var(--slate)">
        <ul>
          <li>{d} is provided "as is", without warranties of any kind, and without any promise that it will be available, accurate or complete.</li>
          <li>To the extent the law allows, we're not liable for losses from using or relying on {d}, including trading losses or liquidations; and our total liability is limited to what you paid us in the 30 days before the claim.</li>
          <li>We may change these terms; the date at the top changes when we do, and paid periods keep the terms they were bought under for price and refunds.</li>
        </ul>
      </Panel>
    </div>
  );
}
