/**
 * /watch — Telegram alerts (docs/ALERTS.md). For Pro (10 wallets) and Desk (100 wallets).
 *   1. Connect Telegram: a one-time link opens the bot already linked to this account
 *   2. Wallets and lines: the same list the bot's /watch, /hf, /buffer, /scenario commands edit
 *   3. Pause and Ink-wide events
 * Read-only like everything else: Phrourax reads the chain and sends a message. It never touches a wallet.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { DIRECTIONS } from '@aegis/pose';
import { Panel } from '../components/bits';
import { useMe } from '../lib/account';
import { LEVEL_COLOR, LEVEL_LABEL, alertsPost, fetchAlerts, type AlertWatch, type AlertsMe } from '../lib/alerts';

const ALERT_COMMANDS: Array<[string, string]> = [
  ['/watch <address> [tydro|nado]', 'watch a wallet'],
  ['/unwatch <address>', 'stop watching it'],
  ['/list', 'what you watch'],
  ['/status [address]', 'last known state, or read one now'],
  ['/hf <address> <1.0–5 | off>', 'alert when Tydro HF falls below'],
  ['/buffer <address> <1–90 | off>', 'alert when the worst Nado margin buffer (%) falls below'],
  ['/scenario <address> <BTC|ETH|…> <±pct | off>', 'alert when that move would liquidate it'],
  ['/protocol <on | off>', 'also Ink-wide events: oracle problems, parameter changes, Ink Stress Level changes, liquidation cascades, failed checks'],
  ['/pause · /resume', 'hold or restart your alerts'],
  ['/delete', 'unlink this chat (your wallets stay on your account)'],
];

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ago = (ms: number) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  return m < 1 ? 'just now' : m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

export function AlertsPage() {
  const me = useMe();
  const on = me.status === 'ok' && me.me.alerts === true;
  return (
    <div className="stack alerts-page" data-testid="alerts-page" data-live={on ? 'yes' : 'no'}>
      <h2 className="page">Alerts</h2>
      {me.status === 'loading' ? <div className="dim">…</div> : null}
      {me.status === 'ok' && !on ? (
        <div className="banner" data-testid="alerts-unavailable" role="status">
          COMING SOON · BUILT AND TESTED — Telegram alerts are not accepting sign-ups yet. No bot is currently available to message.
        </div>
      ) : null}
      {on && !me.me.signedIn ? (
        <Panel title="Telegram alerts — Pro and Desk" rail="var(--cyan)" testId="alerts-signedout">
          <p>Get a Telegram message when a wallet you watch moves toward liquidation, crosses a line you set, or would be liquidated by a move you name. Pro watches 10 wallets, Desk 100.</p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Link className="pill-btn solid" to="/signin?next=/watch">Sign in</Link>
            <Link className="pill-btn" to="/pricing">See plans</Link>
          </div>
        </Panel>
      ) : null}
      {on && me.me.signedIn ? <Manage /> : null}
      <About />
    </div>
  );
}

function Manage() {
  const [a, setA] = useState<AlertsMe | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setA(await fetchAlerts()), []);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (path: Parameters<typeof alertsPost>[0], body: unknown): Promise<boolean> => {
    setBusy(true);
    setErr(null);
    const r = await alertsPost(path, body);
    setBusy(false);
    if (!r.ok) {
      setErr(r.message);
      return false;
    }
    setA(r.data);
    return true;
  };

  if (!a) return <div className="dim">Loading your alerts…</div>;
  if (!a.enabled) return null;
  if (!a.limit) {
    return (
      <Panel title="Telegram alerts — Pro and Desk" rail="var(--amber)" testId="alerts-needs-plan">
        <p>Alerts come with a plan: Pro watches 10 wallets, Desk 100. Your wallets and lines are kept if you had them before.</p>
        <Link className="pill-btn solid" to="/pricing" data-testid="alerts-choose-plan">Choose a plan</Link>
      </Panel>
    );
  }
  return (
    <>
      {err ? <div className="banner" role="alert" data-testid="alerts-error">{err}</div> : null}
      <Connect a={a} reload={load} act={act} busy={busy} />
      <Wallets a={a} act={act} busy={busy} />
      <Settings a={a} act={act} busy={busy} />
    </>
  );
}

type Act = (path: Parameters<typeof alertsPost>[0], body: unknown) => Promise<boolean>;

function Connect({ a, reload, act, busy }: { a: AlertsMe; reload: () => Promise<void>; act: Act; busy: boolean }) {
  const [link, setLink] = useState<{ url: string; until: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  // after "Connect", look for the link to land (the bot answers Telegram at once)
  useEffect(() => {
    if (!link || a.linked) return;
    timer.current = window.setInterval(() => {
      if (Date.now() > link.until) setLink(null);
      else void reload();
    }, 3000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [link, a.linked, reload]);
  useEffect(() => {
    if (a.linked) setLink(null);
  }, [a.linked]);
  const connect = async () => {
    setErr(null);
    const r = await alertsPost<{ url: string; expiresInS: number }>('link', {});
    if (!r.ok) return setErr(r.message);
    if (!/^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\?start=[A-Za-z0-9_-]+$/.test(r.data.url)) return setErr('Unexpected Telegram address — nothing was opened.');
    setLink({ url: r.data.url, until: Date.now() + r.data.expiresInS * 1000 });
  };
  return (
    <Panel idx="1" title="Telegram" rail={a.linked ? 'var(--cyan)' : 'var(--amber)'} testId="alerts-connect">
      {a.linked ? (
        <div className="stack" style={{ gap: 8 }}>
          <p style={{ margin: 0 }} data-testid="alerts-linked">
            <span className="tag" style={{ color: 'var(--cyan)' }}>LINKED</span> Alerts go to your Telegram chat with{' '}
            {a.bot ? <a className="mono" href={`https://t.me/${a.bot}`} target="_blank" rel="noreferrer">@{a.bot}</a> : 'the Phrourax bot'}
            {a.linkedAt ? <span className="dim"> · since {new Date(a.linkedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span> : null}.
          </p>
          <div>
            <button className="pill-btn" disabled={busy} onClick={() => void act('unlink', {})} data-testid="alerts-unlink">Unlink this chat</button>
          </div>
        </div>
      ) : link ? (
        <div className="stack" style={{ gap: 10 }} data-testid="alerts-link-ready">
          <a className="pill-btn solid" href={link.url} target="_blank" rel="noreferrer" style={{ alignSelf: 'flex-start' }} data-testid="alerts-open-telegram">
            Open Telegram
          </a>
          <p className="dim" style={{ margin: 0 }}>
            In Telegram, press <b>START</b>. This page updates by itself when the chat is linked. The link works once, for 10 minutes.
          </p>
        </div>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          <p style={{ margin: 0 }}>Link a Telegram chat to receive alerts. Phrourax stores the chat's id (encrypted) and nothing else from Telegram.</p>
          <button className="pill-btn solid" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => void connect()} data-testid="alerts-connect-btn">
            Connect Telegram
          </button>
          {err ? <div className="auth-error" role="alert">{err}</div> : null}
        </div>
      )}
    </Panel>
  );
}

function Wallets({ a, act, busy }: { a: AlertsMe; act: Act; busy: boolean }) {
  const [addr, setAddr] = useState('');
  const ws = a.watches ?? [];
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await act('watch', { address: addr.trim() })) setAddr('');
  };
  return (
    <Panel idx="2" title="Wallets" rail="var(--slate)" right={<span className="mono" data-testid="alerts-count">{ws.filter((w) => !w.overLimit).length} / {a.limit}</span>} testId="alerts-wallets">
      <form className="auth-form" onSubmit={(e) => void add(e)} style={{ marginBottom: 12 }}>
        <label className="sr-only" htmlFor="alerts-add">Wallet address</label>
        <input id="alerts-add" placeholder="0x… wallet address to watch" value={addr} onChange={(e) => setAddr(e.target.value)} spellCheck={false} autoComplete="off" data-testid="alerts-add-input" />
        <button className="pill-btn solid" type="submit" disabled={busy || !addr.trim()} data-testid="alerts-add-btn">Watch</button>
      </form>
      {ws.length === 0 ? <p className="dim" style={{ margin: 0 }}>No wallets yet. Add one above, or send <span className="mono">/watch &lt;address&gt;</span> to the bot.</p> : null}
      <div className="alerts-list">
        {ws.map((w) => (
          <WatchRow key={w.address} w={w} act={act} busy={busy} />
        ))}
      </div>
      {!a.linked && ws.length ? <p className="dim" style={{ margin: '10px 0 0', fontSize: 12.5 }}>These are checked once a Telegram chat is linked (step 1).</p> : null}
    </Panel>
  );
}

function linesText(w: AlertWatch): string {
  const p: string[] = [];
  if (w.venue !== 'any') p.push(`${w.venue} only`);
  if (w.hfBelow !== null) p.push(`HF < ${w.hfBelow.toFixed(2)}`);
  if (w.bufferPct !== null) p.push(`buffer < ${w.bufferPct}%`);
  if (w.scenario) p.push(`${w.scenario.direction} ${w.scenario.pct > 0 ? '+' : ''}${w.scenario.pct}% scenario`);
  return p.length ? p.join(' · ') : 'risk level changes only';
}

function WatchRow({ w, act, busy }: { w: AlertWatch; act: Act; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [hf, setHf] = useState(w.hfBelow?.toString() ?? '');
  const [buf, setBuf] = useState(w.bufferPct?.toString() ?? '');
  const [dir, setDir] = useState(w.scenario?.direction ?? '');
  const [pct, setPct] = useState(w.scenario?.pct.toString() ?? '-20');
  const [venue, setVenue] = useState(w.venue);
  const save = async () => {
    const ok = await act('watch', {
      address: w.address,
      venue,
      hfBelow: hf.trim() === '' ? null : hf.trim(),
      bufferPct: buf.trim() === '' ? null : buf.trim(),
      scenario: dir ? { direction: dir, pct: pct.trim() } : null,
    });
    if (ok) setOpen(false);
  };
  const lv = w.level;
  return (
    <div className="alerts-row" data-testid="alerts-row" data-over={w.overLimit ? 'yes' : 'no'}>
      <div className="alerts-row-main">
        <Link className="mono" to={`/hull/${w.address}`}>{short(w.address)}</Link>
        {w.overLimit ? (
          <span className="tag" style={{ color: 'var(--slate)' }} title="Over your plan's limit: kept, not checked">NOT CHECKED</span>
        ) : lv ? (
          <span className="tag" style={{ color: LEVEL_COLOR[lv] }} data-testid="alerts-level">{LEVEL_LABEL[lv]}</span>
        ) : (
          <span className="tag" style={{ color: 'var(--slate)' }}>NOT READ YET</span>
        )}
        <span className="dim alerts-lines">{linesText(w)}{w.checkedAt ? ` · checked ${ago(w.checkedAt)}` : ''}</span>
        <span className="alerts-row-btns">
          <button className="pill-btn" onClick={() => setOpen((x) => !x)} aria-expanded={open} data-testid="alerts-edit">{open ? 'Close' : 'Lines'}</button>
          <button className="pill-btn" disabled={busy} onClick={() => void act('unwatch', { address: w.address })} data-testid="alerts-remove">Remove</button>
        </span>
      </div>
      {open ? (
        <div className="alerts-edit" data-testid="alerts-edit-form">
          <label>
            <span>Venue</span>
            <select value={venue} onChange={(e) => setVenue(e.target.value as AlertWatch['venue'])}>
              <option value="any">Tydro and Nado</option>
              <option value="tydro">Tydro only</option>
              <option value="nado">Nado only</option>
            </select>
          </label>
          <label>
            <span>Tydro HF below</span>
            <input inputMode="decimal" placeholder="off" value={hf} onChange={(e) => setHf(e.target.value)} data-testid="alerts-hf" />
          </label>
          <label>
            <span>Nado buffer below %</span>
            <input inputMode="decimal" placeholder="off" value={buf} onChange={(e) => setBuf(e.target.value)} />
          </label>
          <label>
            <span>If this moved</span>
            <select value={dir} onChange={(e) => setDir(e.target.value)}>
              <option value="">off</option>
              {DIRECTIONS.map((d) => (
                <option key={d.id} value={d.id}>{d.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>by %</span>
            <input inputMode="numeric" value={pct} disabled={!dir} onChange={(e) => setPct(e.target.value)} />
          </label>
          <button className="pill-btn solid" disabled={busy} onClick={() => void save()} data-testid="alerts-save">Save</button>
          <p className="faint" style={{ flexBasis: '100%', margin: 0, fontSize: 12 }}>
            Leave a box empty to switch that line off. The scenario uses the same engine as the Pressure Map — a simulation, not a prediction.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Settings({ a, act, busy }: { a: AlertsMe; act: Act; busy: boolean }) {
  return (
    <Panel idx="3" title="Settings" rail="var(--slate)" testId="alerts-settings">
      <label className="alerts-toggle">
        <input type="checkbox" checked={a.paused === true} disabled={busy} onChange={(e) => void act('settings', { paused: e.target.checked })} data-testid="alerts-pause" />
        <span>Pause all alerts <span className="dim">(wallets are kept)</span></span>
      </label>
      <label className="alerts-toggle">
        <input type="checkbox" checked={a.protocol === true} disabled={busy} onChange={(e) => void act('settings', { protocol: e.target.checked })} data-testid="alerts-protocol" />
        <span>Also Ink-wide events <span className="dim">— oracle problems, Tydro/Nado parameter changes, Ink Stress Level changes, liquidation cascades, failed checks</span></span>
      </label>
      <p className="dim" style={{ margin: '8px 0 0', fontSize: 12.5 }} data-testid="alerts-lastrun">
        {a.lastRun ? `Last check ${ago(a.lastRun.at)}${a.lastRun.ok ? '' : ' (had problems — some wallets may be read next time)'}. ` : 'The first check runs within about 10 minutes. '}
        Wallets are checked about every 10 minutes, not instantly — don&apos;t rely on alerts as your only warning.
      </p>
    </Panel>
  );
}

function About() {
  return (
    <>
      <Panel title="What alerts do" rail="var(--slate)">
        <p className="dim">You get a Telegram message when a watched wallet changes:</p>
        <ul className="dim">
          <li>risk level SAFE → WATCH → NEAR LIQUIDATION → LIQUIDATABLE, and back (a recovery must hold on consecutive readings before it&apos;s announced);</li>
          <li>your own lines: Tydro health factor below a number, Nado margin buffer below a percent (worst subaccount), or &ldquo;if ETH fell 20% this would be liquidated&rdquo;;</li>
          <li>the classification changes, a venue can&apos;t be read, or a reading is stale or partial — said plainly, never shown as current;</li>
          <li>a watched wallet is actually liquidated on-chain (always on, from the Liquidation Ledger).</li>
        </ul>
        <p className="dim">Same readers, rules and scenario engine as the rest of Phrourax. The same alert isn&apos;t repeated inside an hour, and each chat has an hourly cap (the worst news always goes through).</p>
      </Panel>
      <Panel title="Bot commands" rail="var(--slate)">
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
          <li>Stored with your account: the wallets and lines you set, and your Telegram chat id — encrypted. Nothing else from Telegram. Unlinking (here or <span className="mono">/delete</span>) removes the chat id at once.</li>
          <li>Messages carry the risk level, HF / margin buffer, data age and block — never balances or position sizes.</li>
          <li>Phrourax never asks for a key, never connects to a wallet and cannot move funds. Private chats only.</li>
        </ul>
      </Panel>
    </>
  );
}
