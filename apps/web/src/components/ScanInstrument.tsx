import { useState } from 'react';
import { sharePct, type CensusSnapshot } from '@aegis/census';
import { NO_TYPE_LABEL, TAG_LABEL, tagColor } from '@aegis/glyphs';
import type { Tag } from '@aegis/pose';
import { fmtAge } from '../lib/fmt';

/*
 * SCAN INSTRUMENT — the hero of the Scan page. Three nested rings say how much of each protocol's own on-chain
 * totals the wallets AEGIS found add up to:
 *   outer   Tydro supplied + borrowed (two thin arcs; one closed ring when both are 100%)
 *   middle  Nado deposits
 *   inner   Nado open interest: longs and shorts as two thin arcs
 * Lit arc = the share seen, from 12 o'clock clockwise. Dark arc = not seen — drawn empty, never filled with
 * anything. Around the rings, one tick per position type, its length = that type's share of drawn wallets; a click
 * or tap keeps one type lit and reads it out underneath (it filters the ticks only, never the well).
 * Shares and wallet counts only: no dollars, no health factors.
 */

const C = 200; // centre of the 400 × 400 drawing
const TICK_ORDER: Array<Tag | 'NONE'> = ['CARRY', 'EQUITY-MARGIN', 'NAKED', 'KBTC-CORE', 'LOCKED', 'STABLE-BALLAST', 'LEVERED', 'HOLD', 'WOUNDED', 'DARK', 'NONE'];
const TICK_R0 = 166;
const TICK_MAX = 30;
const LIT = 'var(--cyan)';
const UNSEEN = 'rgba(160, 175, 190, 0.11)';
const UNSEEN_EDGE = 'rgba(160, 175, 190, 0.38)';

type RingKey = 'tydro' | 'nadoDeposits' | 'nadoOi';

const clamp01 = (x: number | null) => (x === null ? 0 : Math.max(0, Math.min(1, x)));
/** " · 17.9% not seen" when a share falls short of the whole */
const unseen = (x: number | null) => (x !== null && x < 0.9995 ? <span className="faint"> · {((1 - x) * 100).toFixed(1)}% not seen</span> : null);
const typeName = (k: Tag | 'NONE') => (k === 'NONE' ? NO_TYPE_LABEL : TAG_LABEL[k]);
const typeColor = (k: Tag | 'NONE') => (k === 'NONE' ? '#6B7280' : tagColor(k));

/** SVG arc from 12 o'clock clockwise over `frac` of the circle. */
function arcPath(r: number, frac: number): string {
  const f = Math.min(frac, 0.99999);
  const a = f * Math.PI * 2;
  const x = C + r * Math.sin(a);
  const y = C - r * Math.cos(a);
  return `M ${C} ${C - r} A ${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
}

function Ring({ r, share, width, id, onHover, dim }: { r: number; share: number | null; width: number; id: string; onHover: () => void; dim: boolean }) {
  const f = clamp01(share);
  return (
    <g data-testid={`ring-${id}`} data-share={share === null ? '' : share.toFixed(4)} onMouseEnter={onHover} onTouchStart={onHover} style={{ opacity: dim ? 0.55 : 1, transition: 'opacity 150ms' }}>
      {/* the whole track, dark: what was not seen */}
      <circle cx={C} cy={C} r={r} fill="none" stroke={UNSEEN} strokeWidth={width} />
      {/* dashed edges: an empty track reads as "nothing seen here", not as a gap in the drawing */}
      <circle cx={C} cy={C} r={r + width / 2 + 0.5} fill="none" stroke={UNSEEN_EDGE} strokeWidth="0.75" strokeDasharray="2 3" />
      <circle cx={C} cy={C} r={r - width / 2 - 0.5} fill="none" stroke={UNSEEN_EDGE} strokeWidth="0.75" strokeDasharray="2 3" />
      {/* lit: what was seen */}
      {f >= 0.9995 ? (
        <circle cx={C} cy={C} r={r} fill="none" stroke={LIT} strokeWidth={width} data-testid={`ring-${id}-lit`} data-closed="1" />
      ) : f > 0 ? (
        <path d={arcPath(r, f)} fill="none" stroke={LIT} strokeWidth={width} data-testid={`ring-${id}-lit`} data-closed="0" />
      ) : null}
      {/* a wide invisible band so hovering anywhere on the ring works */}
      <circle cx={C} cy={C} r={r} fill="none" stroke="transparent" strokeWidth={Math.max(width, 16)} style={{ pointerEvents: 'stroke' }} />
    </g>
  );
}

export function ScanInstrument({ snap, now }: { snap: CensusSnapshot; now: number }) {
  const [picked, setPicked] = useState<Tag | 'NONE' | null>(null);
  const [hover, setHover] = useState<RingKey | null>(null);
  const cov = snap.coverage ?? null;
  const s = cov?.share ?? null;
  const total = Object.values(snap.mix).reduce((a, b) => a + b, 0);
  const types = TICK_ORDER.map((k) => ({ k, n: snap.mix[k] ?? 0 }));
  const tydroClosed = !!s && clamp01(s.tydroSupply) >= 0.9995 && clamp01(s.tydroDebt) >= 0.9995;
  const scanAt = cov ? `full scan at block ${cov.block.toLocaleString('en-US')} (${fmtAge(Date.parse(cov.at), now)} ago)` : 'measured on the next full scan (weekly)';

  const RING_TEXT: Record<RingKey, string> = {
    tydro: `Tydro supplied ${sharePct(s?.tydroSupply ?? null)} · borrowed ${sharePct(s?.tydroDebt ?? null)}`,
    nadoDeposits: `Nado deposits ${sharePct(s?.nadoDeposits ?? null)}`,
    nadoOi: `Nado open interest · longs ${sharePct(s?.nadoOpenInterestLongs ?? null)} · shorts ${sharePct(s?.nadoOpenInterestShorts ?? null)}`,
  };
  const pickedRow = picked ? types.find((t) => t.k === picked)! : null;

  return (
    <section className="panel scan-inst" style={{ ['--rail' as string]: 'var(--cyan)' }} data-testid="scan-instrument">
      <div className="rail" aria-hidden />
      <div className="body">
        <h3 className="panel-title">
          Coverage and position types
          <span className="right">lit = seen · dark = not seen</span>
        </h3>
        <div className="scan-grid">
          <svg
            className="scan-svg"
            viewBox="0 0 400 400"
            role="img"
            aria-label={`Coverage: ${RING_TEXT.tydro}; ${RING_TEXT.nadoDeposits}; ${RING_TEXT.nadoOi}.`}
            onMouseLeave={() => setHover(null)}
          >
            {/* outer: Tydro supplied (outside) + borrowed (inside); one closed ring when both are 100% */}
            {tydroClosed ? (
              <Ring r={146} share={1} width={10} id="tydro" onHover={() => setHover('tydro')} dim={hover !== null && hover !== 'tydro'} />
            ) : (
              <g>
                <Ring r={149} share={s?.tydroSupply ?? null} width={4} id="tydro-supplied" onHover={() => setHover('tydro')} dim={hover !== null && hover !== 'tydro'} />
                <Ring r={142} share={s?.tydroDebt ?? null} width={4} id="tydro-borrowed" onHover={() => setHover('tydro')} dim={hover !== null && hover !== 'tydro'} />
              </g>
            )}
            {/* middle: Nado deposits */}
            <Ring r={116} share={s?.nadoDeposits ?? null} width={10} id="nado-deposits" onHover={() => setHover('nadoDeposits')} dim={hover !== null && hover !== 'nadoDeposits'} />
            {/* inner: Nado open interest, longs (outside) and shorts (inside) */}
            <Ring r={89} share={s?.nadoOpenInterestLongs ?? null} width={4} id="nado-oi-longs" onHover={() => setHover('nadoOi')} dim={hover !== null && hover !== 'nadoOi'} />
            <Ring r={82} share={s?.nadoOpenInterestShorts ?? null} width={4} id="nado-oi-shorts" onHover={() => setHover('nadoOi')} dim={hover !== null && hover !== 'nadoOi'} />

            {/* centre */}
            <text x={C} y={C - 6} textAnchor="middle" className="scan-c-num">{snap.counts.drawn.toLocaleString('en-US')}</text>
            <text x={C} y={C + 14} textAnchor="middle" className="scan-c-lbl">WALLETS DRAWN</text>

            {/* one tick per position type, length = its share of drawn wallets */}
            {types.map((t, i) => {
              const a = (i / types.length) * Math.PI * 2;
              const share = total ? t.n / total : 0;
              const len = t.n ? 3 + share * (TICK_MAX / 0.5) : 0;
              const L = Math.min(len, TICK_MAX + 3);
              const x0 = C + TICK_R0 * Math.sin(a), y0 = C - TICK_R0 * Math.cos(a);
              const x1 = C + (TICK_R0 + L) * Math.sin(a), y1 = C - (TICK_R0 + L) * Math.cos(a);
              const xh = C + (TICK_R0 + TICK_MAX + 3) * Math.sin(a), yh = C - (TICK_R0 + TICK_MAX + 3) * Math.cos(a);
              const on = picked === null || picked === t.k;
              const toggle = () => setPicked((p) => (p === t.k ? null : t.k));
              return (
                <g
                  key={t.k}
                  role="button"
                  tabIndex={0}
                  aria-pressed={picked === t.k}
                  aria-label={`${typeName(t.k)}: ${t.n.toLocaleString('en-US')} wallets`}
                  className="scan-tick"
                  data-testid="scan-tick"
                  data-type={t.k}
                  data-count={t.n}
                  onClick={toggle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggle();
                    }
                  }}
                  style={{ opacity: on ? 1 : 0.18, transition: 'opacity 150ms' }}
                >
                  <title>{`${typeName(t.k)} · ${t.n.toLocaleString('en-US')} wallets`}</title>
                  {/* faint guide to full length, so an empty type still has a place to tap */}
                  <line x1={x0} y1={y0} x2={xh} y2={yh} stroke="var(--hair-2)" strokeWidth="1" />
                  {t.n ? <line x1={x0} y1={y0} x2={x1} y2={y1} stroke={typeColor(t.k)} strokeWidth={picked === t.k ? 6 : 4} strokeLinecap="butt" /> : null}
                  <line x1={x0} y1={y0} x2={xh} y2={yh} stroke="transparent" strokeWidth="18" />
                </g>
              );
            })}
          </svg>

          <div className="scan-read" data-testid="scan-readout">
            <div className="scan-cap">COVERAGE · {scanAt}</div>
            <dl className="kv tight">
              <dt>tydro supplied</dt><dd className="num" data-testid="cov-tydro-supplied">{sharePct(s?.tydroSupply ?? null)}</dd>
              <dt>tydro borrowed</dt><dd className="num" data-testid="cov-tydro-borrowed">{sharePct(s?.tydroDebt ?? null)}</dd>
              <dt>nado deposits</dt><dd className="num" data-testid="cov-nado-deposits">{sharePct(s?.nadoDeposits ?? null)}{unseen(s?.nadoDeposits ?? null)}</dd>
              <dt>nado open longs</dt><dd className="num" data-testid="cov-nado-longs">{sharePct(s?.nadoOpenInterestLongs ?? null)}{unseen(s?.nadoOpenInterestLongs ?? null)}</dd>
              <dt>nado open shorts</dt><dd className="num" data-testid="cov-nado-shorts">{sharePct(s?.nadoOpenInterestShorts ?? null)}{unseen(s?.nadoOpenInterestShorts ?? null)}</dd>
            </dl>
            <div className="scan-hover mono" data-testid="scan-hover">
              {hover ? `${RING_TEXT[hover]} · ${scanAt}` : 'Point at or tap a ring for its share. Rings: outer Tydro · middle Nado deposits · inner Nado open interest.'}
            </div>

            <div className="scan-cap" style={{ marginTop: 14 }}>WALLETS</div>
            <dl className="kv tight">
              <dt>found</dt><dd className="num">{snap.counts.known.toLocaleString('en-US')}</dd>
              <dt>with a position</dt><dd className="num">{snap.counts.drawn.toLocaleString('en-US')}</dd>
              <dt>empty</dt><dd className="num">{snap.counts.empty.toLocaleString('en-US')}</dd>
              <dt>on tydro</dt><dd className="num">{snap.counts.tydro.toLocaleString('en-US')}</dd>
              <dt>on nado</dt><dd className="num">{snap.counts.nado.toLocaleString('en-US')}</dd>
              <dt>near liquidation</dt><dd className="num">{snap.counts.wounded.toLocaleString('en-US')}</dd>
              <dt>couldn't read</dt><dd className="num">{snap.counts.dark.toLocaleString('en-US')}</dd>
            </dl>
          </div>
        </div>

        <div className="scan-pick mono" data-testid="scan-pick">
          {pickedRow ? (
            <>
              <i style={{ background: typeColor(pickedRow.k) }} aria-hidden />
              {typeName(pickedRow.k)} · {pickedRow.n.toLocaleString('en-US')} wallets · {total ? ((pickedRow.n / total) * 100).toFixed(1) : '0.0'}% of drawn
              <button type="button" className="sq-btn" onClick={() => setPicked(null)} style={{ marginLeft: 10 }}>Clear</button>
            </>
          ) : (
            <span className="faint">Ticks around the rings: one per position type, length = its share of drawn wallets. Click one to read it out.</span>
          )}
        </div>
      </div>
    </section>
  );
}
