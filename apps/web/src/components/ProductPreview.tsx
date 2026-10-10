/**
 * What Phrourax does, shown to visitors without a plan — honestly (docs/PAYWALL.md):
 *  - public evidence: only facts that are already public (chain head, rules version, verification, the public
 *    Checks and track-record files). Unavailable → said so, never a zero.
 *  - feature previews: the six made-up TEST wallets from /fixtures run through the real classifier and scenario
 *    engine, labelled DEMO DATA; or the feature's structure with no data at all. Nothing here requests a paid file —
 *    the server refuses them anyway.
 */
import { Link } from 'react-router-dom';
import { useMemo } from 'react';
import { DIRECTIONS, RULES, canBeLiquidated, classify, confidenceOf, directionScenario, shockBook, stressState, type Book, type HullTemp, type Pose } from '@aegis/pose';
import { BRAND, RISK_LABEL } from '@aegis/glyphs';
import { INK_CHAIN_ID } from '@aegis/ink-io';
import { FIXTURES } from '../lib/fixtures';
import { useChainHead, useNow } from '../lib/hulls';
import { useAccountability } from '../lib/history';
import { useVerificationLog } from '../lib/verificationLog';
import { VERIFIED, verificationText } from '../lib/verification';
import { useMe } from '../lib/account';
import { fmtAge } from '../lib/fmt';
import { TagChip, TEMP_RAIL } from './bits';
import { LockIcon } from './Paywall';

/** The most representative test wallet: both venues, a hedged structure, a stress test with rows. */
export const DEMO_WALLET = { name: 'carry', href: '/fixture/carry' } as const;
const DEMO_ORDER = ['carry', 'equity-margin', 'naked', 'wounded', 'dark', 'empty'] as const;
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null);

export function DemoLabel({ what = 'DEMO DATA — MADE-UP TEST WALLETS' }: { what?: string }) {
  return <div className="demo-label" data-testid="demo-label">{what}</div>;
}

function RiskText({ t }: { t: HullTemp | 'LIQ' }) {
  const color = t === 'LIQ' ? 'var(--red)' : TEMP_RAIL[t];
  return <span className="mono risk-text" style={{ color }}>{t === 'LIQ' ? 'Liquidatable' : RISK_LABEL[t]}</span>;
}

function useDemoWallets(): Array<{ name: string; href: string; book: Book; pose: Pose }> {
  return useMemo(() => DEMO_ORDER.map((name) => ({ name, href: `/fixture/${name}`, book: FIXTURES[name]!, pose: classify(FIXTURES[name]!) })), []);
}

/* ───────────────────────── calls to action ───────────────────────── */

export function DemoWalletLink({ className = 'pill-btn', label = 'Explore a demo wallet' }: { className?: string; label?: string }) {
  return (
    <Link className={className} to={DEMO_WALLET.href} data-testid="demo-wallet-link" title="A made-up test wallet with hand-written values — not a real account">
      {label}
    </Link>
  );
}

export function PreviewActions({ checkWallet = true }: { checkWallet?: boolean }) {
  const me = useMe();
  const signedIn = me.status === 'ok' && me.me.signedIn;
  const focusPaste = () => {
    const el = document.querySelector<HTMLInputElement>('[data-testid="paste-input"]');
    el?.scrollIntoView({ block: 'center' });
    el?.focus();
  };
  return (
    <div className="preview-actions" data-testid="preview-actions">
      {checkWallet ? <button type="button" className="pill-btn amber" onClick={focusPaste} data-testid="cta-check">Check a wallet</button> : null}
      <DemoWalletLink />
      <Link className="pill-btn solid" to="/pricing" data-testid="cta-plans">See plans</Link>
      {signedIn ? null : <Link className="pill-btn" to="/signin" data-testid="cta-signin">Sign in</Link>}
    </div>
  );
}

/* ───────────────────────── public evidence ───────────────────────── */

export function PublicEvidence() {
  const { head, error } = useChainHead();
  const now = useNow(5000);
  const acct = useAccountability();
  const log = useVerificationLog();
  const a = acct.status === 'ok' ? acct.a : null;
  const unavailable = (s: { status: string }) => (s.status === 'loading' ? 'loading…' : s.status === 'none' || s.status === 'missing' ? 'not recorded yet' : 'unavailable');
  const lastCheck = log.status === 'ok' && log.records.length ? log.records.reduce((m, r) => (r.at > m ? r.at : m), log.records[0]!.at) : null;
  const rows: Array<[string, React.ReactNode]> = [
    ['Chain', <span className="mono">Ink · {INK_CHAIN_ID}</span>],
    ['Latest block', head ? <span className="mono">{head.block.toLocaleString('en-US')} <span className="faint">· read {fmtAge(head.readAt, now)} ago</span></span> : <span className="faint">{error ? 'RPC unavailable' : 'reading…'}</span>],
    ['Rules', <span className="mono">{RULES.RULES_VERSION} <Link to={{ search: '?rules=1' }}>read them</Link></span>],
    ['Readings checked', <span>{VERIFIED ? 'Verified against the official apps' : verificationText()}</span>],
    ['Automatic checks', log.status === 'ok' ? <span className="mono">{log.records.length.toLocaleString('en-US')} recorded{lastCheck ? <span className="faint"> · last {fmtAge(Date.parse(lastCheck), now)} ago</span> : null}</span> : <span className="faint">{unavailable(log)}</span>],
    ['Recording since', a?.recordingStart ? <span className="mono">{day(a.recordingStart)}</span> : <span className="faint">{a ? 'not started' : unavailable(acct)}</span>],
    ['Liquidations evaluable', a ? <span className="mono">{a.liquidations.evaluable.toLocaleString('en-US')} <span className="faint">of {a.liquidations.total.toLocaleString('en-US')} recorded</span></span> : <span className="faint">{unavailable(acct)}</span>],
    ['New warnings recorded', a?.transitions ? <span className="mono">{a.transitions.available ? a.transitions.counted.toLocaleString('en-US') : <span className="faint">not available yet</span>}</span> : <span className="faint">{a ? 'not available yet' : unavailable(acct)}</span>],
    ['Last scored', a ? <span className="mono">{fmtAge(Date.parse(a.generatedAt), now)} ago <span className="faint">· method {a.version}</span></span> : <span className="faint">{unavailable(acct)}</span>],
  ];
  return (
    <section className="panel evidence" style={{ ['--rail' as string]: 'var(--cyan)' }} data-testid="public-evidence" aria-labelledby="evidence-title">
      <div className="rail" aria-hidden />
      <div className="body">
        <h3 className="panel-title" id="evidence-title">
          Public record
          <span className="right mono">anyone can check this</span>
        </h3>
        <dl className="kv evidence-kv">
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="evidence-links mono">
          <Link to="/calibration">Checks and track record</Link> · <Link to="/developers">API</Link> · Built from public on-chain data · Read-only, no wallet connection
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── feature previews ───────────────────────── */

export function WellPreview() {
  const demo = useDemoWallets();
  return (
    <div className="mini">
      <DemoLabel />
      <table className="t mini-t" aria-label="Demo: the six made-up test wallets by position type and risk">
        <thead><tr><th>Test wallet</th><th>Position type</th><th>Risk</th></tr></thead>
        <tbody>
          {demo.map((w) => (
            <tr key={w.name}>
              <td className="mono"><Link to={w.href}>{w.name}</Link></td>
              <td><div className="tags">{w.pose.tags.length ? w.pose.tags.slice(0, 2).map((t) => <TagChip key={t} tag={t} />) : <TagChip tag={null} />}</div></td>
              <td><RiskText t={w.pose.hullTemp} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The real scenario engine on the test wallets: all crypto −30% (a defined move, the same engine as Pressure). */
export function PressurePreview() {
  const demo = useDemoWallets();
  const dir = DIRECTIONS.find((d) => d.id === 'CRYPTO')!;
  const rows = useMemo(
    () =>
      demo.map((w) => {
        if (!canBeLiquidated(w.book)) return { ...w, after: null as null | HullTemp | 'LIQ', note: 'nothing to liquidate' };
        if (confidenceOf(w.book).confidence === 'UNSUPPORTED') return { ...w, after: null, note: "can't simulate — a venue wasn't read" };
        const st = stressState(shockBook(w.book, directionScenario(dir, -30)));
        return { ...w, after: (st.liquidatable ? 'LIQ' : st.hullTemp) as HullTemp | 'LIQ', note: '' };
      }),
    [demo, dir],
  );
  return (
    <div className="mini">
      <DemoLabel what="DEMO DATA — MADE-UP TEST WALLETS · SIMULATION, NOT PREDICTION" />
      <table className="t mini-t" aria-label="Demo: risk now and if all crypto fell 30 percent, for the made-up test wallets">
        <thead><tr><th>Test wallet</th><th>Risk now</th><th>If all crypto −30%</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td className="mono"><Link to={r.href}>{r.name}</Link></td>
              <td><RiskText t={r.pose.hullTemp} /></td>
              <td>{r.after ? <RiskText t={r.after} /> : <span className="faint">{r.note}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function IntelPreview() {
  const acct = useAccountability();
  const since = acct.status === 'ok' ? day(acct.a.recordingStart) : null;
  const rows: Array<[string, string]> = [
    ['History', 'risk counts, position-type mix and venues, every hour'],
    ['Liquidations', 'every liquidation on both venues, and whether a warning came first'],
    ['Oracles', 'each asset’s price sources, their age, and disagreements'],
    ['Changes', 'protocol parameter changes, old → new, with the block'],
    ['Carry', 'estimated net carry per structure (analysis only)'],
  ];
  return (
    <div className="mini">
      <DemoLabel what="STRUCTURE — NO DATA SHOWN" />
      <dl className="kv mini-kv">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="faint mono mini-foot">{since ? `Recorded live by the hourly scan since ${since}.` : 'Recorded live by the hourly scan.'}</div>
    </div>
  );
}

export function ScanPreview() {
  const rows: Array<[string, string]> = [
    ['Found from', 'public on-chain events: Tydro token transfers, Nado deposits and trades'],
    ['Read', 'every wallet, hourly, straight from the Ink chain'],
    ['Coverage', 'known wallets measured against each protocol’s own on-chain totals — the part not seen is shown, never filled in'],
    ['Browse', 'by position type, with each type’s share of the wallets found'],
  ];
  return (
    <div className="mini">
      <DemoLabel what="STRUCTURE — NO DATA SHOWN" />
      <dl className="kv mini-kv">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ───────────────────────── the four paid surfaces ───────────────────────── */

export const FEATURES = {
  well: {
    name: 'The Well',
    to: '/',
    benefit: 'Every Tydro and Nado wallet Phrourax has found, organised by position type and current risk.',
    problem: 'Checking one wallet tells you about one wallet. The Well shows the whole Ink risk surface at once — with the near-liquidation list and live activity.',
    caps: ['Every discovered wallet, by position type and risk', 'The near-liquidation list, ordered by when each wallet arrived there', 'Live updates as wallets act, between hourly scans'],
    Preview: WellPreview,
  },
  pressure: {
    name: 'Pressure',
    to: '/pressure',
    benefit: 'How defined market moves would change observable liquidation risk across Ink.',
    problem: 'A health factor describes today. Pressure inspects how observable positions across Ink respond to defined market moves. Simulation, not prediction.',
    caps: ['Test defined moves: crypto, ETH, BTC, stablecoin depegs', 'Compare venues, size ranges and position types', 'See wallets move between risk states under a scenario'],
    Preview: PressurePreview,
  },
  intel: {
    name: 'Intel',
    to: '/intel',
    benefit: 'Recorded ecosystem history, liquidations, oracle events and protocol changes.',
    problem: 'A snapshot can’t show what changed. Intel follows recorded changes instead of relying on a single reading.',
    caps: ['Review recorded risk history, hour by hour', 'Follow liquidations and oracle events', 'Examine protocol changes and carry analysis'],
    Preview: IntelPreview,
  },
  scan: {
    name: 'Scan',
    to: '/census',
    benefit: 'Which wallets the scan has found across Tydro and Nado, and how complete that coverage is.',
    problem: 'Numbers mean little without knowing what they cover. Scan shows the wallets found and the share of each protocol they account for.',
    caps: ['Browse discovered wallets by position type', 'See coverage against each protocol’s own totals', 'Understand how wallets were found and read'],
    Preview: ScanPreview,
  },
} as const;
export type FeatureKey = keyof typeof FEATURES;

function FeatureCard({ k }: { k: FeatureKey }) {
  const f = FEATURES[k];
  const P = f.Preview;
  return (
    <section className="panel feature-card" style={{ ['--rail' as string]: 'var(--amber)' }} data-testid={`feature-${k}`} aria-labelledby={`feature-${k}-title`}>
      <div className="rail" aria-hidden />
      <div className="body">
        <h3 className="panel-title" id={`feature-${k}-title`}>
          {f.name}
          <span className="right mono feature-lock"><LockIcon /> Pro</span>
        </h3>
        <p className="feature-benefit">{f.benefit}</p>
        <P />
      </div>
    </section>
  );
}

/** The homepage for visitors without a plan: evidence, what each paid part does, and the ways in. */
export default function HomePreview() {
  return (
    <div className="stack home-preview" data-testid="home-preview">
      <PreviewActions />
      <div className="demo-note faint" data-testid="demo-note">
        The demo wallet is made up — hand-written test values, not a real account. It opens the full wallet page, stress test included.
      </div>
      <PublicEvidence />
      <h3 className="preview-h" id="unlock-title">What a plan unlocks</h3>
      <div className="grid two feature-grid" aria-labelledby="unlock-title">
        <FeatureCard k="well" />
        <FeatureCard k="pressure" />
        <FeatureCard k="intel" />
        <FeatureCard k="scan" />
      </div>
      <div className="faint mono preview-foot">
        {BRAND.display} is read-only: it never connects to a wallet and can&apos;t move funds. Information only — not financial advice.
      </div>
    </div>
  );
}

/** A locked paid page: what it's for, three things it does, a safe preview, the ways in. */
export function LockedFeature({ k }: { k: Exclude<FeatureKey, 'well'> }) {
  const f = FEATURES[k];
  const P = f.Preview;
  return (
    <section className="panel locked-feature" style={{ ['--rail' as string]: 'var(--amber)' }} data-testid="locked-page" aria-labelledby="locked-feature-title">
      <div className="rail" aria-hidden />
      <div className="body">
        <h3 className="panel-title" id="locked-feature-title">
          {f.name}
          <span className="right mono"><LockIcon /> Subscribers only</span>
        </h3>
        <div className="locked-feature-grid">
          <div className="stack" style={{ gap: 10 }}>
            <p className="feature-problem">{f.problem}</p>
            <ul className="feature-caps">
              {f.caps.map((c) => <li key={c}>{c}</li>)}
            </ul>
            <PreviewActions checkWallet={false} />
          </div>
          <div>
            <P />
          </div>
        </div>
      </div>
    </section>
  );
}
