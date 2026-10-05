import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Mark } from './Mark';
import { useMyWallet } from '../lib/myWallet';
import { BRAND, COPY } from '@aegis/glyphs';
import { INK_CHAIN_ID } from '@aegis/ink-io';
import { fmtAge } from '../lib/fmt';
import { useChainHead, useNow } from '../lib/hulls';
import { ENV } from '../lib/env';
import { RulesContent } from './RulesContent';

/**
 * The rules live in ONE place: the drawer. It opens over whatever page you are on and is part of the address
 * (?rules=1), so a link can open it and the back button closes it. The old /rules page redirects here.
 */
export const RULES_LINK = { search: '?rules=1' } as const;

/** Canonical and og:url follow the page (path only — never a query or a wallet address). */
function useCanonical() {
  const { pathname } = useLocation();
  useEffect(() => {
    const path = pathname.startsWith('/hull/') || pathname.startsWith('/fixture/') ? '/' : pathname;
    const href = `${BRAND.siteUrl}${path}`;
    document.querySelector('link[rel="canonical"]')?.setAttribute('href', href);
    document.querySelector('meta[property="og:url"]')?.setAttribute('content', href);
  }, [pathname]);
}

export function Shell() {
  useCanonical();
  const [params, setParams] = useSearchParams();
  const drawer = params.get('rules') === '1';
  const setDrawer = (open: boolean) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (open) next.set('rules', '1');
        else next.delete('rules');
        return next;
      },
      { replace: !open },
    );
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawer]);
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Mark size={28} /></span>
          <div>
            <h1>{BRAND.name}</h1>
            <small>TYDRO · NADO · INK {INK_CHAIN_ID}</small>
          </div>
        </div>
        <nav className="nav" aria-label="Primary">
          <NavLink to="/" end>Well</NavLink>
          <NavLink to="/pressure">Pressure</NavLink>
          <NavLink to="/intel">Intel</NavLink>
          <NavLink to="/census">Scan</NavLink>
          <NavLink to="/watch">Alerts</NavLink>
          <NavLink to="/calibration">Checks</NavLink>
          <button className="pill-btn" onClick={() => setDrawer(true)} data-testid="rules-drawer-btn">Rules</button>
        </nav>
        <MyWalletButton />
      </header>
      <main>
        <Outlet />
      </main>
      <Footer />
      {drawer ? (
        <>
          <div className="drawer-scrim" onClick={() => setDrawer(false)} />
          <aside className="drawer" role="dialog" aria-label="Rules" data-testid="rules-drawer">
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
              <h2 className="page" style={{ margin: 0 }}>Rules</h2>
              <button className="pill-btn" onClick={() => setDrawer(false)}>Close</button>
            </div>
            <RulesContent />
          </aside>
        </>
      ) : null}
    </div>
  );
}

/** "My wallet": a shortcut to the wallet you saved on its page. No wallet extension is ever asked for anything. */
function MyWalletButton() {
  const mine = useMyWallet();
  const nav = useNavigate();
  if (!mine) return null;
  return (
    <button className="pill-btn" onClick={() => nav(`/hull/${mine}`)} title="Saved in this browser only. Phrourax never connects to your wallet." data-testid="my-wallet">
      My wallet {mine.slice(0, 6)}…{mine.slice(-4)}
    </button>
  );
}

function Footer() {
  const { head, error } = useChainHead();
  const now = useNow();
  let rpcHost = ENV.inkRpc;
  try {
    rpcHost = new URL(ENV.inkRpc).host;
  } catch {
    /* keep raw */
  }
  return (
    <footer className="footer" data-testid="footer">
      <span>chain {INK_CHAIN_ID}</span>
      <span className="sep">·</span>
      <span>block {head ? <span className="num">{head.block.toLocaleString('en-US')}</span> : error ? <span style={{ color: 'var(--red)' }}>couldn't read</span> : '…'}</span>
      <span className="sep">·</span>
      <span>rpc age {head ? fmtAge(head.readAt, now) : '—'} <span className="faint">({rpcHost})</span></span>
      {error ? (
        <>
          <span className="sep">·</span>
          <span style={{ color: 'var(--red)' }}>{error}</span>
        </>
      ) : null}
      <span className="sep">·</span>
      <span>read-only, not a broker</span>
      <span className="sep">·</span>
      <Link to={RULES_LINK}>rules</Link>
      <span className="camera" style={{ flexBasis: '100%' }}>{COPY.footer}</span>
    </footer>
  );
}
