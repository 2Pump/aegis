import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Book, NadoBook, Pose, TydroBook } from '@aegis/pose';
import { COPY, HULL_COPY, RISK_LABEL, TAG_LABEL, darkReasonText, hullSigilSvg, reasonParts, summaryText } from '@aegis/glyphs';
import { INK_EXPLORER, parseAddress, TYDRO_FETCHED } from '@aegis/ink-io';
import { fmtAge, fmtAmt, fmtPct, fmtUsd } from '../lib/fmt';
import { Lamp, Panel, TagChip, TEMP_RAIL, Usd } from './bits';
import { SensorLog } from './SensorLog';
import { VENUE_VERIFIED, VERIFIED, verificationText } from '../lib/verification';
import { setMyWallet, useMyWallet } from '../lib/myWallet';

export interface HullPlateProps {
  book: Book;
  pose: Pose;
  lastOk: { tydro: number | null; nado: number | null };
  firstSeen: number;
  now: number;
  loading?: boolean;
  nextInMs?: number | null;
  onRefresh?: () => void;
}

export function HullPlate({ book, pose, lastOk, firstSeen, now, loading, nextInMs, onRefresh }: HullPlateProps) {
  const isFixture = book.source === 'FIXTURE';
  const parsed = parseAddress(book.address);
  const checksum = parsed.ok ? parsed.value.checksum : book.address;
  const sigil = useMemo(() => hullSigilSvg(book.address, pose, 112), [book.address, pose]);
  const rail = TEMP_RAIL[pose.hullTemp];

  return (
    <div className="stack" data-testid="hull-plate">
      {isFixture ? (
        <div className="banner cyan" data-testid="fixture-banner">
          TEST WALLET — made-up example “{book.label}”. Not a real account. Prices are hand-written test values.
        </div>
      ) : !VERIFIED ? (
        <div className="banner" data-testid="unverified-plate">
          {VENUE_VERIFIED.tydro || VENUE_VERIFIED.nado
            ? `PARTLY CHECKED — ${verificationText()}. Numbers from the unchecked venue may be off.`
            : 'READINGS NOT YET CHECKED — these numbers have not yet been matched against app.tydro.com / app.nado.xyz for a real wallet. Treat them as provisional.'}
        </div>
      ) : null}

      {/* hero */}
      <div className="hero">
        <div className="sigil" dangerouslySetInnerHTML={{ __html: sigil }} />
        <div className="stack" style={{ gap: 8, minWidth: 0 }}>
          <div className="tags">
            <TagChip tag={pose.primary} primary filled />
            {pose.tags.filter((t) => t !== pose.primary).map((t) => (
              <TagChip key={t} tag={t} />
            ))}
          </div>
          <div className="mono dim" style={{ overflowWrap: 'anywhere' }}>{checksum}</div>
          <div className="row">
            <Lamp state={book.tydro.status === 'OK' ? 'ok' : 'dark'} label={book.tydro.status === 'OK' ? 'TYDRO OK' : "TYDRO COULDN'T READ"} />
            <Lamp state={book.nado.status === 'OK' ? 'ok' : 'dark'} label={book.nado.status === 'OK' ? 'NADO OK' : "NADO COULDN'T READ"} />
            {!isFixture ? (
              <span className="faint mono" style={{ fontSize: 11 }}>
                {loading ? 'reading…' : nextInMs !== null && nextInMs !== undefined ? `next read ${Math.ceil(nextInMs / 1000)}s` : ''}
              </span>
            ) : null}
            {onRefresh && !isFixture ? (
              <button className="pill-btn" onClick={onRefresh} disabled={loading} data-testid="refresh">
                Re-read
              </button>
            ) : null}
            {!isFixture ? <MyWalletToggle address={book.address} /> : null}
          </div>
        </div>
      </div>

      <div className="grid two">
        {/* 1 WALLET */}
        <Panel idx="01" title="Wallet">
          <dl className="kv">
            <dt>address</dt>
            <dd className="mono">
              {isFixture ? checksum : <a href={`${INK_EXPLORER}/address/${checksum}`} target="_blank" rel="noreferrer">{checksum}</a>}
            </dd>
            <dt>ens</dt>
            <dd className="faint">not wired (later)</dd>
            <dt>first seen</dt>
            <dd className="mono">{new Date(firstSeen).toISOString().replace('T', ' ').slice(0, 19)} UTC <span className="faint">(this browser session)</span></dd>
            <dt>tydro last read</dt>
            <dd className="mono">{lastOk.tydro ? `${fmtAge(lastOk.tydro, now)} ago` : 'never'}{book.asOfBlock ? ` · block ${book.asOfBlock.toLocaleString('en-US')}` : ''}</dd>
            <dt>nado last read</dt>
            <dd className="mono">{lastOk.nado ? `${fmtAge(lastOk.nado, now)} ago` : 'never'}</dd>
            <dt>source</dt>
            <dd className="mono">{book.source === 'FIXTURE' ? 'test wallet' : 'read live from chain'}</dd>
          </dl>
        </Panel>

        {/* 2 RISK */}
        <Panel idx="02" title="Risk" rail={rail} testId="hull-temp">
          <div className={`temp ${pose.hullTemp}`}>{RISK_LABEL[pose.hullTemp].toUpperCase()}</div>
          <div className="dim" style={{ marginTop: 4 }}>{HULL_COPY[pose.hullTemp]}</div>
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>tydro health factor</dt>
            <dd className="num">{pose.metrics.hf === null ? (book.tydro.status === 'OK' ? '∞ (no debt)' : "— couldn't read") : pose.metrics.hf.toFixed(3)}</dd>
            <dt>tydro distance to liquidation</dt>
            <dd className="num">{pose.liqDistanceBps === null ? '—' : fmtPct(pose.liqDistanceBps / 10_000)}</dd>
            <dt>nado margin buffer</dt>
            <dd className="num">{fmtPct(pose.metrics.nadoBuffer)}</dd>
          </dl>
        </Panel>
      </div>

      {/* 3 POSITION TYPE */}
      <Panel idx="03" title="Position type — why" rail={rail} right={<span className="mono">rules {pose.rulesVersion} · <Link to={{ search: '?rules=1' }}>read rules</Link></span>} testId="pose-panel">
        <ul className="reasons" data-testid="reasons">
          {pose.reasons.map((r, i) => (
            <li key={i}><Reason r={r} /></li>
          ))}
        </ul>
        {pose.darkReasons.length ? (
          <ul className="reasons" style={{ marginTop: 8, ['--rail' as string]: 'var(--red)' }} data-testid="dark-reasons">
            {pose.darkReasons.map((r, i) => (
              <li key={i}>{darkReasonText(r)}</li>
            ))}
          </ul>
        ) : null}
      </Panel>

      <div className="grid two">
        {/* 4 TYDRO */}
        <Panel idx="04" title="Tydro lending" rail="var(--slate)" right={<span className="mono">market list {TYDRO_FETCHED}</span>}>
          {book.tydro.status === 'OK' ? <Locker t={book.tydro.data} fixture={isFixture} /> : <Dark code={book.tydro.code} msg={book.tydro.message} />}
        </Panel>

        {/* 5 NADO */}
        <Panel idx="05" title="Nado account" rail="var(--violet)">
          {book.nado.status === 'OK' ? <NadoTable n={book.nado.data} /> : <Dark code={book.nado.code} msg={book.nado.message} />}
        </Panel>
      </div>

      {/* 6 EXPOSURE */}
      <Panel idx="06" title="Exposure" rail="var(--cyan)">
        {pose.residualDeltaUsd === null ? (
          <div className="dim">Can't be worked out — one venue couldn't be read, and AEGIS does not guess from half the picture.</div>
        ) : (
          <>
            <dl className="kv">
              <dt>net price exposure</dt>
              <dd className="num">{fmtUsd(pose.residualDeltaUsd)} <span className="faint">({fmtPct(pose.residualDeltaFrac)} of total)</span></dd>
              <dt>equity</dt>
              <dd className="num">{fmtUsd(pose.metrics.E)}</dd>
              <dt>total perp size</dt>
              <dd className="num">{fmtUsd(pose.metrics.grossPerpUsd)}</dd>
              <dt>total margin</dt>
              <dd className="num">{fmtUsd(pose.metrics.totalMarginUsd)}</dd>
            </dl>
            {pose.metrics.families.length ? (
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table className="t">
                  <thead>
                    <tr>
                      <th>Coin</th>
                      <th className="r">Held</th>
                      <th className="r">Perp long</th>
                      <th className="r">Perp short</th>
                      <th className="r">gap</th>
                      <th className="r">net</th>
                      <th>type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pose.metrics.families.map((f) => (
                      <tr key={f.family}>
                        <td className="mono">{f.family}</td>
                        <td className="r num">{fmtUsd(f.S)}</td>
                        <td className="r num">{fmtUsd(f.L)}</td>
                        <td className="r num">{fmtUsd(f.P)}</td>
                        <td className="r num">{fmtPct(f.carryGap)}</td>
                        <td className={`r num ${f.residualUsd >= 0 ? 'pos' : 'neg'}`}>{fmtUsd(f.residualUsd)}</td>
                        <td className="mono">{f.carry ? TAG_LABEL.CARRY : f.naked ? TAG_LABEL.NAKED : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        )}
      </Panel>

      {/* 7 SHARE */}
      <Share book={book} pose={pose} checksum={checksum} />

      <Panel idx="··" title="Data log" rail="var(--ink-faint)" right={<span className="mono">on-page diagnostics</span>}>
        {isFixture ? <div className="dim">Test wallet — no network reads.</div> : <SensorLog scope={book.address} />}
      </Panel>
    </div>
  );
}

function Reason({ r }: { r: string }) {
  const p = reasonParts(r);
  if (!p.label) return <>{r}</>;
  return (
    <>
      <b>{p.label}</b> <span className="faint mono" style={{ fontSize: 11 }}>{p.tag}</span> · {p.rest}
    </>
  );
}

/** Remember this address as "my wallet" (this browser only). Replaces wallet connect: nothing is ever asked of a wallet. */
function MyWalletToggle({ address }: { address: string }) {
  const mine = useMyWallet();
  const isMine = mine === address.toLowerCase();
  return isMine ? (
    <button className="pill-btn" onClick={() => setMyWallet(null)} title="Saved in this browser only. Click to forget it." data-testid="my-wallet-toggle">
      ✓ My wallet · forget
    </button>
  ) : (
    <button className="pill-btn" onClick={() => setMyWallet(address)} title="Adds a My wallet shortcut to the header. Saved in this browser only; AEGIS never connects to your wallet." data-testid="my-wallet-toggle">
      Set as my wallet
    </button>
  );
}

function Dark({ code, msg }: { code: string; msg: string }) {
  return (
    <div className="stack" style={{ gap: 6 }} data-testid="sensor-dark">
      <Lamp state="dark" label={`COULDN'T READ · ${code}`} />
      <div className="mono dim" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{msg}</div>
    </div>
  );
}

function Locker({ t, fixture }: { t: TydroBook; fixture: boolean }) {
  const src = fixture ? 'FIXTURE' : 'TYDRO_ORACLE';
  const rows = [...t.supplies.map((l) => ({ ...l, side: 'SUPPLY' })), ...t.debts.map((l) => ({ ...l, side: 'DEBT' }))];
  return (
    <div className="stack" style={{ gap: 10 }}>
      <dl className="kv">
        <dt>health factor</dt>
        <dd className="num">{t.hf === null ? '∞ (no debt)' : t.hf.toFixed(3)}</dd>
        <dt>collateral</dt>
        <dd><Usd n={t.totalCollateralUsd} src={src} /></dd>
        <dt>debt</dt>
        <dd><Usd n={t.totalDebtUsd} src={src} /></dd>
        <dt>liquidation threshold</dt>
        <dd className="num">{fmtPct(t.liquidationThreshold)}</dd>
      </dl>
      {rows.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr><th>Side</th><th>Asset</th><th className="r">Amount</th><th className="r">USD</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.side + r.symbol}>
                  <td className={`mono ${r.side === 'DEBT' ? 'neg' : 'pos'}`}>{r.side}</td>
                  <td className="mono">{r.symbol}</td>
                  <td className="r num">{fmtAmt(r.amount)}</td>
                  <td className="r"><Usd n={r.usd} src={r.priceSource} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="dim">No Tydro supplies or debts.</div>
      )}
      {t.notes.map((n, i) => (
        <div key={i} className="banner">{n}</div>
      ))}
    </div>
  );
}

function NadoTable({ n }: { n: NadoBook }) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      <dl className="kv">
        <dt>equity</dt>
        <dd><Usd n={n.equityUsd} src={n.spots[0]?.priceSource ?? n.perps[0]?.priceSource ?? 'NADO_ONCHAIN'} /></dd>
        <dt>margin health</dt>
        <dd className="num">{n.maintenance ? `${fmtUsd(n.maintenance.healthUsd)} of ${fmtUsd(n.maintenance.assetsUsd)} weighted assets` : '—'}</dd>
        <dt>subaccounts</dt>
        <dd className="mono" style={{ fontSize: 11 }}>{n.subaccounts.length ? n.subaccounts.map(subName).join(', ') : 'none with balances'}</dd>
      </dl>
      {n.spots.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr><th>Spot / collateral</th><th className="r">Amount</th><th className="r">USD</th></tr>
            </thead>
            <tbody>
              {n.spots.map((s) => (
                <tr key={s.subaccount + s.productId}>
                  <td className="mono">{s.symbol}{s.amount < 0 ? <span className="src">BORROW</span> : null}</td>
                  <td className="r num">{fmtAmt(s.amount)}</td>
                  <td className="r"><Usd n={s.usd} src={s.priceSource} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {n.perps.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr><th>Perp</th><th>Side</th><th className="r">Size</th><th className="r">Notional</th><th className="r">Unsettled</th></tr>
            </thead>
            <tbody>
              {n.perps.map((p) => (
                <tr key={p.subaccount + p.productId}>
                  <td className="mono">{p.symbol}</td>
                  <td className={`mono ${p.sizeBase >= 0 ? 'pos' : 'neg'}`}>{p.sizeBase >= 0 ? 'LONG' : 'SHORT'}</td>
                  <td className="r num">{fmtAmt(p.sizeBase)}</td>
                  <td className="r"><Usd n={Math.abs(p.notionalUsd)} src={p.priceSource} /></td>
                  <td className="r num">{fmtUsd(p.unsettledUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {!n.spots.length && !n.perps.length ? <div className="dim">No Nado balances.</div> : null}
      {n.funding.length ? (
        <div className="mono dim" style={{ fontSize: 12 }}>
          funding side: {n.funding.map((f) => `${f.symbol} ${f.side}`).join(' · ')} <span className="faint">(rates not wired in V1)</span>
        </div>
      ) : null}
      {n.notes.map((x, i) => (
        <div key={i} className={x.includes('OK') ? 'banner cyan' : 'banner'}>{x}</div>
      ))}
    </div>
  );
}

function Share({ book, pose, checksum }: { book: Book; pose: Pose; checksum: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const url = typeof window !== 'undefined' ? `${window.location.origin}/hull/${checksum}` : `/hull/${checksum}`;
  const text = summaryText(checksum, pose, { tydro: book.tydro.status === 'OK', nado: book.nado.status === 'OK' }, url);
  const copy = async (what: string, s: string) => {
    try {
      await navigator.clipboard.writeText(s);
      setCopied(what);
    } catch {
      setCopied('clipboard blocked — select the text below');
    }
    setTimeout(() => setCopied(null), 2000);
  };
  return (
    <Panel idx="07" title="Share" rail="var(--amber)">
      <div className="stack" style={{ gap: 8 }}>
        <pre className="log" style={{ maxHeight: 'none', margin: 0 }} data-testid="share-text">{text}</pre>
        <div className="row">
          <button className="pill-btn" onClick={() => void copy('link', url)} disabled={book.source === 'FIXTURE'}>Copy link</button>
          <button className="pill-btn" onClick={() => void copy('summary', text)}>Copy summary for X</button>
          {copied ? <span className="mono dim" style={{ fontSize: 12 }}>{copied === 'link' || copied === 'summary' ? `copied ${copied}` : copied}</span> : null}
        </div>
        <div className="faint mono" style={{ fontSize: 11 }}>{COPY.share} Share text never includes balances.</div>
      </div>
    </Panel>
  );
}

/** bytes32 subaccount → its 12-byte ASCII name ("default", or "iso…" for isolated). */
function subName(sub: string): string {
  const hex = sub.slice(42).replace(/(00)+$/, '');
  let out = '';
  for (let i = 0; i < hex.length; i += 2) {
    const c = parseInt(hex.slice(i, i + 2), 16);
    out += c >= 32 && c < 127 ? String.fromCharCode(c) : '·';
  }
  return out || '(unnamed)';
}
