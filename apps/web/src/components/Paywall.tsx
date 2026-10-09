/**
 * The paywall on screen (docs/PAYWALL.md). With PAYWALL off — or accounts off — everything renders as before.
 * Locked pages never load their data: the paid component isn't mounted at all, and the server refuses the files anyway.
 */
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useMe, usePlanGate } from '../lib/account';
import { Panel } from './bits';

export function LockIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden className="lock-icon">
      <rect x="1.5" y="4.5" width="7" height="5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3 4.5V3a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/** "Subscribers only" panel: what the part shows, and the way in. */
export function Locked({ title, blurb, testId = 'locked' }: { title: string; blurb: ReactNode; testId?: string }) {
  const me = useMe();
  const { pathname } = useLocation();
  const signedIn = me.status === 'ok' && me.me.signedIn;
  return (
    <Panel title={title} rail="var(--amber)" testId={testId}>
      <div className="locked">
        <div className="locked-k"><LockIcon size={11} /> Subscribers only</div>
        <p className="locked-blurb">{blurb}</p>
        <div className="row" style={{ gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link className="pill-btn solid" to="/pricing" data-testid="locked-plans">See plans</Link>
          {signedIn ? null : <Link className="pill-btn" to={`/signin?next=${encodeURIComponent(pathname)}`} data-testid="locked-signin">Sign in</Link>}
        </div>
      </div>
    </Panel>
  );
}

/** A whole page that needs a plan. */
export function PaidPage({ heading, title, blurb, children }: { heading: string; title: string; blurb: ReactNode; children: ReactNode }) {
  const gate = usePlanGate();
  if (gate === 'open') return <>{children}</>;
  return (
    <div className="stack">
      <h2 className="page">{heading}</h2>
      {gate === 'loading' ? <div className="dim" role="status">…</div> : <Locked title={title} blurb={blurb} testId="locked-page" />}
    </div>
  );
}

/** Header: SUBSCRIBE while the paywall is on and this visitor has no plan. */
export function SubscribeButton() {
  const me = useMe();
  if (me.status !== 'ok' || !me.me.paywall || me.me.access !== 'free') return null;
  return <Link className="pill-btn amber" to="/pricing" data-testid="nav-subscribe">Subscribe</Link>;
}
