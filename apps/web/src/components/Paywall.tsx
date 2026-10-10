/**
 * The paywall on screen (docs/PAYWALL.md). With PAYWALL off — or accounts off — everything renders as before.
 * Locked pages never load their data: the paid component isn't mounted at all, and the server refuses the files anyway.
 */
import { lazy, Suspense, type ReactNode } from 'react';
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
export function Locked({ title, blurb, testId = 'locked', demo = false }: { title: string; blurb: ReactNode; testId?: string; demo?: boolean }) {
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
          {demo ? (
            <Link className="pill-btn" to="/fixture/carry" data-testid="demo-wallet-link" title="A made-up test wallet with hand-written values — not a real account">
              Explore a demo wallet
            </Link>
          ) : null}
          {signedIn ? null : <Link className="pill-btn" to={`/signin?next=${encodeURIComponent(pathname)}`} data-testid="locked-signin">Sign in</Link>}
        </div>
      </div>
    </Panel>
  );
}

/** A whole page that needs a plan: locked, it explains itself with a safe preview (ProductPreview → LockedFeature). */
export function PaidPage({ heading, feature, children }: { heading: string; feature: 'pressure' | 'intel' | 'scan'; children: ReactNode }) {
  const gate = usePlanGate();
  if (gate === 'open') return <>{children}</>;
  return (
    <div className="stack">
      <h2 className="page">{heading}</h2>
      {gate === 'loading' ? (
        <div className="dim" role="status">…</div>
      ) : (
        <Suspense fallback={<div className="preview-wait" aria-hidden />}>
          <LockedFeature k={feature} />
        </Suspense>
      )}
    </div>
  );
}
const LockedFeature = lazy(() => import('./ProductPreview').then((m) => ({ default: m.LockedFeature })));

/** Header: SUBSCRIBE while the paywall is on and this visitor has no plan. */
export function SubscribeButton() {
  const me = useMe();
  if (me.status !== 'ok' || !me.me.paywall || me.me.access !== 'free') return null;
  return <Link className="pill-btn amber" to="/pricing" data-testid="nav-subscribe">Subscribe</Link>;
}
