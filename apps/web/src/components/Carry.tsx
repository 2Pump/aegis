/**
 * INTEL → CARRY (Release 4, carry-1.0.0). Estimated rates, costs and risks of carry structures that can be built
 * from Tydro and Nado — observed from the chain, analysis only. There is deliberately nothing here to act with:
 * no buttons that trade, borrow or connect, no links into the protocols' apps. Written by the hourly census
 * (history/carry/latest.json).
 */
import { useState } from 'react';
import { CARRY, type CarryFile, type CarryRisk, type CarryStructure } from '@aegis/census';
import { Panel } from './bits';
import { when } from './HistoryBits';
import { WELL_ON } from '../lib/census';
import { useCarry } from '../lib/history';

const RISK_COLOR: Record<CarryRisk, string> = { LOW: '#3b8f88', MEDIUM: 'var(--amber)', HIGH: 'var(--red)', UNKNOWN: 'var(--slate)' };
const RiskChip = ({ r }: { r: CarryRisk }) => (
  <span className="mono oracle-chip" style={{ borderColor: RISK_COLOR[r], color: RISK_COLOR[r] }}>{r}</span>
);
/** annual rate → "4.25%" (signed when negative); null → "—" (never 0) */
export const apr = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(d)}%`);
const usd = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `$${Math.round(x).toLocaleString('en-US')}`);
const KIND_TITLE: Record<CarryStructure['kind'], string> = {
  lend: 'Lending (the baseline every carry is compared with)',
  'cash-and-carry': 'Spot + short perp (cash-and-carry)',
  'borrowed-hedge': 'Borrowed asset + hedge',
};

export function CarryPanel() {
  const s = useCarry();
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Panel title="Yield and carry" rail="var(--amber)" testId="intel-carry" right={<span className="mono">{CARRY.VERSION}</span>}>
        <div className="stack" style={{ gap: 10 }}>
          <div className="banner" data-testid="carry-disclaimer">
            ANALYSIS ONLY — estimated from what the chain paid. Rates change every block, everything is before slippage, and nothing here is a promise of a return. AEGIS cannot trade, borrow or move funds.
          </div>
          {s.status === 'loading' ? <div className="dim" role="status">Loading…</div> : null}
          {s.status === 'error' ? <div className="banner red" role="alert">Couldn&apos;t load ({s.message}). Nothing is shown rather than a guess.</div> : null}
          {s.status === 'none' ? (
            <div className="banner" data-testid="carry-not-started">
              NOT RECORDING YET — the hourly scan starts reading rates and funding after this update. Its first run also reads the last 30 days of each market straight from the chain.
            </div>
          ) : null}
          {s.status === 'ok' ? <Body f={s.v} /> : null}
        </div>
      </Panel>
      {s.status === 'ok' ? <Markets f={s.v} /> : null}
      {s.status === 'ok' ? <Existing f={s.v} /> : null}
      {s.status === 'ok' ? <Method f={s.v} /> : null}
    </div>
  );
}

function Body({ f }: { f: CarryFile }) {
  const ageH = (Date.now() - f.at) / 3_600_000;
  const groups = (['lend', 'cash-and-carry', 'borrowed-hedge'] as const).map((k) => [k, f.structures.filter((x) => x.kind === k)] as const).filter(([, xs]) => xs.length);
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="faint mono" style={{ fontSize: 11 }} data-testid="carry-asof">
        Read at block {f.block.toLocaleString('en-US')} · {when(f.at)} · daily history {f.history.days} day{f.history.days === 1 ? '' : 's'}
        {f.history.from ? ` since ${when(f.history.from).slice(0, 10)}` : ''}
        {f.history.gaps ? ` · ${f.history.gaps} missed day(s) (gaps, not filled in)` : ''}
        {ageH > CARRY.STALE_H ? <b style={{ color: 'var(--amber)' }}> · STALE — {ageH.toFixed(0)} h old</b> : null}
      </div>
      <p className="dim" style={{ fontSize: 13, lineHeight: 1.55, margin: 0 }}>
        Each structure is sized per $1 of capital with the assumptions it states. Rates are annual and not compounded (APR). Tydro publishes current rates; Nado doesn&apos;t, so Nado figures are what was actually paid since the last daily checkpoint. One-off costs are shown separately. Click a structure for its legs, costs, capacity and every risk factor.
      </p>
      {groups.map(([k, xs]) => (
        <div key={k}>
          <div className="panel-title" style={{ marginBottom: 6 }}>{KIND_TITLE[k]}</div>
          <div className="table-wrap">
            <table className="t carry-table" data-testid={`carry-table-${k}`}>
              <thead>
                <tr>
                  <th>Structure</th>
                  <th>Est. net (APR)</th>
                  <th className="hide-narrow">7 d</th>
                  <th className="hide-narrow">30 d</th>
                  <th className="hide-narrow">Daily range</th>
                  <th className="hide-narrow">Risk</th>
                </tr>
              </thead>
              <tbody>
                {xs.map((x) => <Row key={x.id} x={x} />)}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <div className="faint" style={{ fontSize: 11.5 }}>{f.equities}</div>
    </div>
  );
}

function Row({ x }: { x: CarryStructure }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="oracle-row" data-testid={`carry-row-${x.id}`}>
        <td className="carry-title">
          <button type="button" className="linklike" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? '▾' : '▸'} {x.title}
          </button>
          {x.completeness !== 'COMPLETE' ? <span className="faint mono" style={{ fontSize: 10.5 }}> · {x.completeness.toLowerCase()}</span> : null}
          <span className="show-narrow"> <RiskChip r={x.risk} /></span>
        </td>
        <td className="num"><b>{apr(x.net)}</b></td>
        <td className="num hide-narrow">{apr(x.windows.d7.net)}</td>
        <td className="num hide-narrow">{apr(x.windows.d30.net)}</td>
        <td className="num hide-narrow">{x.range.days ? `${apr(x.range.min)} … ${apr(x.range.max)}` : '—'}</td>
        <td className="hide-narrow"><RiskChip r={x.risk} /></td>
      </tr>
      {open ? (
        <tr className="oracle-detail">
          <td colSpan={6}>
            <Detail x={x} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Spark({ d }: { d: CarryStructure['daily'] }) {
  const vals = d.map((p) => p.net).filter((v): v is number => v !== null);
  if (vals.length < 2) return <div className="faint" style={{ fontSize: 12 }}>Not enough recorded days for a chart yet.</div>;
  const W = 300;
  const H = 54;
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const y = (v: number) => H - 4 - ((v - lo) / (hi - lo || 1)) * (H - 8);
  const bw = W / d.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="carry-spark" role="img" aria-label={`Daily net rate over ${d.length} days, from ${apr(Math.min(...vals))} to ${apr(Math.max(...vals))}`}>
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="rgba(160,170,180,0.25)" />
      {d.map((p, i) =>
        p.net === null ? null : (
          <rect key={p.at} x={i * bw + 1} width={Math.max(1, bw - 2)} y={Math.min(y(p.net), y(0))} height={Math.max(1, Math.abs(y(p.net) - y(0)))} fill={p.net < 0 ? 'var(--red)' : 'var(--cyan)'}>
            <title>{`${when(p.at).slice(0, 10)}: ${apr(p.net)}`}</title>
          </rect>
        ),
      )}
    </svg>
  );
}

function Detail({ x }: { x: CarryStructure }) {
  return (
    <div className="stack oracle-detail-body" style={{ gap: 12 }} data-testid={`carry-detail-${x.id}`}>
      <div className="faint" style={{ fontSize: 12.5 }}>{x.sizing}</div>
      <div className="table-wrap">
        <table className="t">
          <thead><tr><th>Leg</th><th>Share</th><th>Now</th><th className="hide-narrow">7 d</th><th className="hide-narrow">30 d</th></tr></thead>
          <tbody>
            {x.components.map((c) => (
              <tr key={c.label}>
                <td className="wrap-text">
                  {c.label}
                  <div className="faint" style={{ fontSize: 11 }}>{c.kind === 'cost' ? 'cost · ' : c.kind === 'funding' ? 'funding · ' : ''}{c.basis}</div>
                </td>
                <td className="num">{(c.weight * 100).toFixed(0)}%</td>
                <td className="num">{c.kind === 'cost' ? `−${apr(c.current)}` : apr(c.current)}</td>
                <td className="num hide-narrow">{apr(c.d7)}</td>
                <td className="num hide-narrow">{apr(c.d30)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="kv tight">
        <dt>Gross</dt><dd>{apr(x.gross)}</dd>
        <dt>Borrowing cost</dt><dd>{x.borrowCost ? `−${apr(x.borrowCost)}` : apr(x.borrowCost)}</dd>
        <dt>Funding</dt><dd>{apr(x.funding)}</dd>
        <dt>Estimated net</dt><dd><b>{apr(x.net)}</b> <span className="faint">per $1 of capital, annual, before fees and slippage · could change any block</span></dd>
        <dt>Observed</dt>
        <dd>
          {(['d1', 'd7', 'd30'] as const).map((k) => (
            <span key={k} style={{ marginRight: 14 }}>
              {k === 'd1' ? 'last checkpoint' : k === 'd7' ? '7 d' : '30 d'} {apr(x.windows[k].net)}{x.windows[k].hours !== null ? <span className="faint"> ({x.windows[k].hours!.toFixed(0)} h)</span> : null}
            </span>
          ))}
        </dd>
        <dt>Daily net</dt>
        <dd>
          <Spark d={x.daily} />
          {x.range.days ? <span className="faint">lowest {apr(x.range.min)}, highest {apr(x.range.max)} over {x.range.days} recorded day(s)</span> : null}
        </dd>
        <dt>One-off costs</dt>
        <dd>
          {x.fees.oneOffUsd !== null ? <>≈ ${x.fees.oneOffUsd.toFixed(2)} on {usd(x.fees.perCapital)}{x.fees.asRateIfHeld !== null ? <span className="faint"> (about {apr(x.fees.asRateIfHeld, 3)} a year if held {x.fees.holdDays} days)</span> : null}</> : 'not computable'}
          <ul className="carry-list">{x.fees.items.map((i) => <li key={i}>{i}</li>)}</ul>
          {x.fees.missing.length ? <div style={{ color: 'var(--amber)', fontSize: 12 }}>Not included: {x.fees.missing.join('; ')}</div> : null}
        </dd>
        <dt>Capacity</dt><dd>{x.capacity.text}</dd>
        <dt>Liquidity</dt><dd>{x.liquidity.join(' · ')}</dd>
        <dt>Liquidation</dt><dd>{x.liquidation.text}</dd>
      </dl>
      <div>
        <div className="panel-title" style={{ marginBottom: 4 }}>Risk factors — risk state is the worst one</div>
        <ul className="oracle-checks">
          {x.factors.map((r) => (
            <li key={r.key}><RiskChip r={r.risk} /> <span className="mono faint">{r.key}</span> {r.text}</li>
          ))}
        </ul>
      </div>
      {x.notes.length || x.assumptions.length ? (
        <ul className="carry-list dim">
          {x.notes.map((n) => <li key={n}>{n}</li>)}
          {x.assumptions.map((n) => <li key={n}>Assumed: {n}</li>)}
        </ul>
      ) : null}
      <div className="faint mono" style={{ fontSize: 10.5 }}>Sources: {[...new Set(x.sources)].join(' · ')} · completeness {x.completeness}{x.missing.length ? ` (${x.missing.join('; ')})` : ''}</div>
    </div>
  );
}

function Markets({ f }: { f: CarryFile }) {
  const [all, setAll] = useState(false);
  const fund = all ? f.markets.funding : f.markets.funding.slice(0, 20);
  return (
    <Panel title="Markets" rail="var(--amber)" testId="carry-markets" right={<span className="mono">rates · funding · capacity</span>}>
      <div className="stack" style={{ gap: 14 }}>
        <div>
          <div className="panel-title" style={{ marginBottom: 6 }}>Tydro reserves</div>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Asset</th><th>Supply now</th><th>Borrow now</th><th>Used</th><th className="hide-narrow">Available</th><th className="hide-narrow">Supply 30 d</th><th className="hide-narrow">Borrow 30 d</th><th className="hide-narrow">Supply cap room</th></tr></thead>
              <tbody>
                {f.markets.tydro.map((m) => (
                  <tr key={m.symbol}>
                    <td className="mono">{m.symbol}{m.flags.length ? <span style={{ color: 'var(--amber)' }}> · {m.flags.join(', ')}</span> : null}</td>
                    <td className="num">{apr(m.supplyApr)}</td>
                    <td className="num">{apr(m.borrowApr)}</td>
                    <td className="num">{m.utilization !== null ? `${(m.utilization * 100).toFixed(0)}%` : '—'}</td>
                    <td className="num hide-narrow">{usd(m.availableUsd)}</td>
                    <td className="num hide-narrow">{apr(m.supply30)}</td>
                    <td className="num hide-narrow">{apr(m.borrow30)}</td>
                    <td className="num hide-narrow">{m.supplyHeadroomUsd === null ? 'no cap' : usd(m.supplyHeadroomUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <div className="panel-title" style={{ marginBottom: 6 }}>Nado spot (observed — Nado publishes no current rate)</div>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Product</th><th>Deposit (last checkpoint)</th><th className="hide-narrow">Deposit 7 d</th><th className="hide-narrow">Borrow 7 d</th><th>Used</th><th className="hide-narrow">Deposits</th><th className="hide-narrow">Withdrawal fee</th></tr></thead>
              <tbody>
                {f.markets.nadoSpot.map((m) => (
                  <tr key={m.productId}>
                    <td className="mono">{m.symbol ?? `#${m.productId}`}</td>
                    <td className="num">{apr(m.deposit1)}</td>
                    <td className="num hide-narrow">{apr(m.deposit7)}</td>
                    <td className="num hide-narrow">{apr(m.borrow7)}</td>
                    <td className="num">{m.utilization !== null ? `${(m.utilization * 100).toFixed(0)}%` : '—'}</td>
                    <td className="num hide-narrow">{usd(m.depositsUsd)}</td>
                    <td className="num hide-narrow">${m.withdrawFeeUsd.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <div className="panel-title" style={{ marginBottom: 6 }}>Nado funding — what a short received (negative = paid), annual</div>
          <div className="table-wrap">
            <table className="t" data-testid="carry-funding">
              <thead><tr><th>Perp</th><th>Last checkpoint</th><th>7 d</th><th className="hide-narrow">30 d</th><th className="hide-narrow">Days against shorts</th><th className="hide-narrow">Open interest</th></tr></thead>
              <tbody>
                {fund.map((m) => (
                  <tr key={m.productId}>
                    <td className="mono">{m.symbol ?? `#${m.productId}`}</td>
                    <td className="num" style={{ color: m.short1 !== null && m.short1 < 0 ? 'var(--red)' : undefined }}>{apr(m.short1)}</td>
                    <td className="num">{apr(m.short7)}</td>
                    <td className="num hide-narrow">{apr(m.short30)}</td>
                    <td className="num hide-narrow">{m.days ? `${m.negativeDays} of ${m.days}` : '—'}</td>
                    <td className="num hide-narrow">{usd(m.openInterestUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {f.markets.funding.length > 20 ? (
            <button type="button" className="sq-btn" style={{ marginTop: 8 }} onClick={() => setAll(!all)}>{all ? 'SHOW FEWER' : `SHOW ALL ${f.markets.funding.length}`}</button>
          ) : null}
          <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>Funding = the change in Nado&apos;s cumulative funding for shorts, divided by the oracle price, annualized. A long pays about the same. Sorted by open interest. Past funding says nothing certain about future funding.</div>
        </div>
        <div className="faint" style={{ fontSize: 11.5 }}>Gas: {f.gas.perTxUsd !== null ? `≈ $${f.gas.perTxUsd.toFixed(4)} per transaction` : 'not read'} — {f.gas.note}.</div>
      </div>
    </Panel>
  );
}

function Existing({ f }: { f: CarryFile }) {
  const e = f.existing;
  return (
    <Panel title="Carry already on Ink" rail="var(--amber)" testId="carry-existing" right={<span className="mono">counts only</span>}>
      {!WELL_ON ? (
        <div className="faint">Locked with the well until the readings are verified (no counts shown).</div>
      ) : e.carryWallets === null ? (
        <div className="dim">{e.note}</div>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          <div style={{ fontSize: 13.5 }}>
            <b>{e.carryWallets.toLocaleString('en-US')}</b> wallets hold a position the rules classify as CARRY · <b>{e.nearOrWorse}</b> near liquidation now · if ETH rose 10%, <b>{e.ifEthUp10}</b> more would be near; if it fell 10%, <b>{e.ifEthDown10}</b>. Ink Stress Level: {e.stress ?? '—'}.
          </div>
          <div className="faint" style={{ fontSize: 11.5 }}>{e.note} Pressure Map block {e.pressureBlock?.toLocaleString('en-US') ?? '—'}.</div>
        </div>
      )}
    </Panel>
  );
}

function Method({ f }: { f: CarryFile }) {
  return (
    <Panel title="How these numbers are made" rail="var(--slate)" testId="carry-method" right={<span className="mono">{f.methodology.version}</span>}>
      <details>
        <summary className="mono dim" style={{ fontSize: 11, cursor: 'pointer' }}>Methodology, risk rules and assumptions</summary>
        <ul className="carry-list dim">{f.methodology.rules.map((r) => <li key={r}>{r}</li>)}</ul>
        <div className="panel-title" style={{ margin: '8px 0 4px' }}>Assumptions</div>
        <ul className="carry-list dim">{f.methodology.assumptions.map((r) => <li key={r}>{r}</li>)}</ul>
        <dl className="kv tight" style={{ marginTop: 8 }}>
          {Object.entries(f.methodology.definitions).map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </details>
      {f.errors.length ? <div className="banner" style={{ marginTop: 8 }}>Some reads failed this run: {f.errors.join('; ')}</div> : null}
    </Panel>
  );
}
