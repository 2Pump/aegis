import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Mark } from './Mark';
import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { COPY } from '@aegis/glyphs';
import { INK_CHAIN_ID } from '@aegis/ink-io';
import { fmtAge } from '../lib/fmt';
import { useChainHead, useNow } from '../lib/hulls';
import { ENV } from '../lib/env';
import { RulesContent } from './RulesContent';

export function Shell() {
  const [drawer, setDrawer] = useState(false);
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Mark size={28} /></span>
          <div>
            <h1>AEGIS</h1>
            <small>TYDRO · NADO · INK {INK_CHAIN_ID}</small>
          </div>
        </div>
        <nav className="nav" aria-label="Primary">
          <NavLink to="/" end>Well</NavLink>
          <NavLink to="/rules">Rules</NavLink>
          <NavLink to="/census">Scan</NavLink>
          <NavLink to="/watch">Alerts</NavLink>
          <NavLink to="/calibration">Checks</NavLink>
          <button className="pill-btn" onClick={() => setDrawer(true)} data-testid="rules-drawer-btn">Rules drawer</button>
        </nav>
        <FocusMyShip />
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

/** Optional connect — read-only. Only purpose: jump to your own wallet page. */
function FocusMyShip() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const nav = useNavigate();
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (asked && isConnected && address) {
      nav(`/hull/${address.toLowerCase()}`);
      setAsked(false);
    }
  }, [asked, isConnected, address, nav]);
  const injectedConn = connectors[0];
  if (isConnected && address) {
    return (
      <div className="row" style={{ gap: 6 }}>
        <button className="pill-btn" onClick={() => nav(`/hull/${address.toLowerCase()}`)} title="Read-only. No signing, no transactions.">
          My wallet {address.slice(0, 6)}…{address.slice(-4)}
        </button>
        <button className="pill-btn" onClick={() => disconnect()}>Disconnect</button>
      </div>
    );
  }
  return (
    <div className="row" style={{ gap: 6 }}>
      <button
        className="pill-btn"
        disabled={!injectedConn || isPending}
        title={injectedConn ? 'Optional. Reads your address only. AEGIS never asks for a signature or approval.' : 'No browser wallet detected — paste an address instead.'}
        onClick={() => {
          if (!injectedConn) return;
          setAsked(true);
          connect({ connector: injectedConn });
        }}
      >
        {isPending ? 'Connecting…' : 'Open my wallet'}
      </button>
      {error ? <span className="mono" style={{ color: 'var(--red)', fontSize: 11 }}>{error.message.split('\n')[0]}</span> : null}
    </div>
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
      <span>camera, not a broker</span>
      <span className="sep">·</span>
      <NavLink to="/rules">rules</NavLink>
      <span className="camera" style={{ flexBasis: '100%' }}>{COPY.footer}</span>
    </footer>
  );
}
