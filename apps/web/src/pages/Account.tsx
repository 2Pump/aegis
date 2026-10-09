/**
 * Sign-in by emailed link (no passwords, never a wallet) and the account page.
 *   /signin          enter an email → "check your inbox"
 *   /auth/verify     the emailed link lands here (token in the #fragment); a button finishes signing in, so a mail
 *                    scanner that opens links can't use the link up
 *   /account         email, plan, sign out
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { BRAND } from '@aegis/glyphs';
import { Panel } from '../components/bits';
import { PLAN_LABEL, authPost, fmtDay, refreshMe, useMe } from '../lib/account';

function NotOn() {
  return (
    <div className="banner" data-testid="accounts-off">
      Accounts aren't switched on yet. Everything on {BRAND.display} works without one for now.
    </div>
  );
}

export function SignInPage() {
  const me = useMe();
  const [params] = useSearchParams();
  const next = params.get('next') ?? undefined;
  const [email, setEmail] = useState('');
  const [state, setState] = useState<{ k: 'idle' | 'sending' } | { k: 'sent'; to: string } | { k: 'error'; msg: string }>({ k: 'idle' });
  const nav = useNavigate();
  useEffect(() => {
    if (me.status === 'ok' && me.me.signedIn) nav(next && next.startsWith('/') && !next.startsWith('//') ? next : '/account', { replace: true });
  }, [me, nav, next]);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setState({ k: 'sending' });
    const r = await authPost<{ sent: boolean }>('start', { email, next });
    setState(r.ok ? { k: 'sent', to: email.trim() } : { k: 'error', msg: r.message });
  };
  return (
    <div className="stack auth-page" data-testid="signin-page">
      <h2 className="page">Sign in</h2>
      {me.status === 'loading' ? <div className="dim">…</div> : null}
      {me.status === 'ok' && !me.me.configured ? <NotOn /> : null}
      {me.status === 'ok' && me.me.configured && !me.me.signedIn ? (
        <Panel title="Sign in or create an account" rail="var(--cyan)">
          {state.k === 'sent' ? (
            <div className="stack" style={{ gap: 8 }} data-testid="signin-sent">
              <p style={{ margin: 0 }}>
                Check <b className="mono">{state.to}</b> for a sign-in link. It works once, for 15 minutes.
              </p>
              <p className="dim" style={{ margin: 0, fontSize: 13 }}>Nothing there? Check spam, or <button type="button" className="linkish" onClick={() => setState({ k: 'idle' })}>send another</button>.</p>
            </div>
          ) : (
            <form className="auth-form" onSubmit={(e) => void send(e)}>
              <label className="sr-only" htmlFor="signin-email">Email</label>
              <input id="signin-email" type="email" required autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="signin-email" />
              <button className="pill-btn solid" type="submit" disabled={state.k === 'sending'} data-testid="signin-send">
                {state.k === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
              </button>
              {state.k === 'error' ? <div className="auth-error" role="alert">{state.msg}</div> : null}
            </form>
          )}
          <p className="faint" style={{ fontSize: 12.5, margin: '14px 0 0' }}>
            No password. We store your email and your plan — nothing about your wallets. {BRAND.display} never asks for your wallet, keys or seed phrase.
          </p>
        </Panel>
      ) : null}
    </div>
  );
}

export function VerifyPage() {
  const nav = useNavigate();
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('t') ?? '');
  const [state, setState] = useState<{ k: 'ready' | 'working' } | { k: 'error'; msg: string }>({ k: 'ready' });
  useEffect(() => {
    // take the token out of the address bar and history straight away
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  }, []);
  const go = async () => {
    setState({ k: 'working' });
    const r = await authPost<{ next?: string }>('verify', { token });
    if (!r.ok) return setState({ k: 'error', msg: r.message });
    await refreshMe();
    nav(r.data.next ?? '/account', { replace: true });
  };
  return (
    <div className="stack auth-page" data-testid="verify-page">
      <h2 className="page">Sign in</h2>
      <Panel title={`Finish signing in to ${BRAND.display}`} rail="var(--cyan)">
        {!token ? (
          <div className="auth-error">This page needs the link from your email. <Link to="/signin">Ask for a new one</Link>.</div>
        ) : state.k === 'error' ? (
          <div className="stack" style={{ gap: 8 }}>
            <div className="auth-error" role="alert" data-testid="verify-error">{state.msg}</div>
            <Link to="/signin" className="pill-btn" style={{ alignSelf: 'flex-start' }}>Get a new link</Link>
          </div>
        ) : (
          <button className="pill-btn solid" onClick={() => void go()} disabled={state.k === 'working'} data-testid="verify-go">
            {state.k === 'working' ? 'Signing in…' : 'Sign in'}
          </button>
        )}
      </Panel>
    </div>
  );
}

export function AccountPage() {
  const me = useMe();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (me.status === 'ok' && me.me.configured && !me.me.signedIn) nav('/signin?next=/account', { replace: true });
  }, [me, nav]);
  const signOut = async (everywhere: boolean) => {
    setBusy(true);
    await authPost('signout', { everywhere });
    // leave the account page first, so it doesn't bounce to sign-in when the state changes
    nav('/', { replace: true });
    await refreshMe();
  };
  if (me.status === 'loading') return <div className="dim">…</div>;
  if (!me.me.configured) return <div className="stack"><h2 className="page">Account</h2><NotOn /></div>;
  if (!me.me.signedIn) return null;
  const m = me.me;
  return (
    <div className="stack auth-page" data-testid="account-page">
      <h2 className="page">Account</h2>
      <Panel title="Your account" rail="var(--cyan)">
        <dl className="kv account-kv">
          <dt>Email</dt>
          <dd className="mono" data-testid="account-email">{m.email}</dd>
          <dt>Plan</dt>
          <dd data-testid="account-plan">
            {PLAN_LABEL[m.access]}
            {m.comp ? <span className="dim"> · complimentary</span> : null}
            {m.access !== 'free' && !m.comp && m.paidUntil ? <span className="dim"> · paid to {fmtDay(m.paidUntil)}</span> : null}
            {m.access === 'free' && m.plan && m.paidUntil ? <span className="dim"> · {PLAN_LABEL[m.plan]} ended {fmtDay(m.paidUntil)}</span> : null}
          </dd>
          {m.since ? (
            <>
              <dt>Member since</dt>
              <dd>{fmtDay(m.since)}</dd>
            </>
          ) : null}
        </dl>
        <div className="row" style={{ marginTop: 14, gap: 8, flexWrap: 'wrap' }}>
          <button className="pill-btn" onClick={() => void signOut(false)} disabled={busy} data-testid="signout">Sign out</button>
          <button className="pill-btn" onClick={() => void signOut(true)} disabled={busy} data-testid="signout-everywhere">Sign out on every device</button>
        </div>
      </Panel>
      <div className="faint mono" style={{ fontSize: 11 }}>
        <Link to="/pricing">See plans</Link> · {BRAND.display} is read-only and never connects to your wallet.
      </div>
    </div>
  );
}

/** Header: SIGN IN, or the plan and a link to the account. Nothing at all while accounts are off. */
export function AccountButton() {
  const me = useMe();
  if (me.status !== 'ok' || !me.me.configured) return null;
  if (!me.me.signedIn) {
    return <Link className="pill-btn" to="/signin" data-testid="nav-signin">Sign in</Link>;
  }
  const m = me.me;
  return (
    <Link className="pill-btn" to="/account" data-testid="nav-account" title={m.email}>
      {PLAN_LABEL[m.access]}
      {m.access !== 'free' && m.paidUntil ? ` · to ${fmtDay(m.paidUntil)}` : ''}
    </Link>
  );
}
