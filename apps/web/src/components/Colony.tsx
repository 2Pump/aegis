import { useEffect, useMemo, useRef, useState } from 'react';
import { sharePct, type CensusSnapshot, type LiveChange } from '@aegis/census';
import { NO_TYPE_LABEL, TAG_LABEL, tagColor } from '@aegis/glyphs';
import type { Tag } from '@aegis/pose';
import { fmtAge } from '../lib/fmt';

/*
 * SCAN — THE LIVING COLONY. A Physarum-style colony on a dark dish is the hero of the Scan page.
 *   Food morsels = position types. Size = that type's share of drawn wallets, colour = the type colour.
 *   Agents sense, turn toward the strongest scent, move, and lay a trail in the colour of the last morsel they
 *   touched; trails diffuse and decay, so busy paths thicken. Click a morsel and the colony leans toward it.
 *   A live type change drops one speck of that type's colour on its morsel.
 * THE GAP IS DRAWN, NOT EATEN. The rim carries three coverage marks — Tydro (outer), Nado deposits (middle),
 * Nado open interest (inner, longs + shorts). Lit arc = share seen; dark arc = NOT SEEN, labelled, and the colony
 * cannot crawl under it: agents are held back from every NOT SEEN arc. Nothing is drawn there.
 * Decoration with honest inputs: the agents are not wallets and carry no data; every number is in the readout.
 * Hidden tab, off-screen or reduced motion: frozen.
 */

const ORDER: Array<Tag | 'NONE'> = ['CARRY', 'EQUITY-MARGIN', 'NAKED', 'KBTC-CORE', 'LEVERED', 'HOLD', 'LOCKED', 'STABLE-BALLAST', 'WOUNDED', 'DARK', 'NONE'];
const nameOf = (k: Tag | 'NONE') => (k === 'NONE' ? NO_TYPE_LABEL : k === 'WOUNDED' ? 'Near liquidation (only type)' : TAG_LABEL[k]);
const colorOf = (k: Tag | 'NONE') => (k === 'NONE' ? '#6B7280' : k === 'WOUNDED' ? '#9CA3AF' : tagColor(k));

// drawing space (SVG units): dish centre 200,200
const CX = 200;
const DISH_R = 170;
const LIT_MAX = 166; // the colony may reach this far under seen rim
const DARK_MAX = 146; // …and only this far under a NOT SEEN arc
const R_TYDRO = 190;
const R_DEP = 181;
const R_OI_L = 174;
const R_OI_S = 170.5;
const G = 200; // simulation grid: 1 cell = 2 SVG units
const CELL = 400 / G;

type Morsel = { k: Tag | 'NONE'; n: number; share: number; x: number; y: number; r: number; rgb: [number, number, number] };

function hexRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
const frac01 = (x: number | null | undefined) => (x === null || x === undefined ? 0 : Math.max(0, Math.min(1, x)));
/** clockwise fraction of the circle from 12 o'clock, for a point relative to the centre (y down) */
const turnOf = (dx: number, dy: number) => {
  const a = Math.atan2(dx, -dy) / (Math.PI * 2);
  return a < 0 ? a + 1 : a;
};
const pt = (r: number, f: number) => [CX + r * Math.sin(f * Math.PI * 2), CX - r * Math.cos(f * Math.PI * 2)] as const;
function arc(r: number, f0: number, f1: number): string {
  if (f1 - f0 >= 0.9999) return `M ${CX} ${CX - r} A ${r} ${r} 0 1 1 ${CX - 0.01} ${CX - r}`;
  const [x0, y0] = pt(r, f0);
  const [x1, y1] = pt(r, f1);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${f1 - f0 > 0.5 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function sector(r0: number, r1: number, f0: number, f1: number): string {
  const [a0x, a0y] = pt(r1, f0);
  const [a1x, a1y] = pt(r1, f1);
  const [b1x, b1y] = pt(r0, f1);
  const [b0x, b0y] = pt(r0, f0);
  const big = f1 - f0 > 0.5 ? 1 : 0;
  return `M ${a0x} ${a0y} A ${r1} ${r1} 0 ${big} 1 ${a1x} ${a1y} L ${b1x} ${b1y} A ${r0} ${r0} 0 ${big} 0 ${b0x} ${b0y} Z`;
}

export function Colony({ snap, now, changes }: { snap: CensusSnapshot; now: number; changes: readonly LiveChange[] }) {
  const cov = snap.coverage ?? null;
  const s = cov?.share ?? null;
  const total = Object.values(snap.mix).reduce((a, b) => a + b, 0);
  const [picked, setPicked] = useState<Tag | 'NONE' | null>(null);

  // coverage → which part of the rim is NOT SEEN (as clockwise fractions from 12 o'clock)
  const dep = frac01(s?.nadoDeposits);
  // deposits held by Nado itself (its NLP vault and protocol accounts): seen, not wallets. Drawn after the wallets' arc.
  const own = frac01(s?.nadoDepositsNadoOwn);
  const depSeen = Math.min(1, dep + own);
  const oiL = frac01(s?.nadoOpenInterestLongs);
  const oiS = frac01(s?.nadoOpenInterestShorts);
  const unseenFrom = cov ? Math.min(depSeen, oiL, oiS) : 0; // the colony is held back from here round to 12 o'clock
  const anyUnseen = unseenFrom < 0.9995;

  // food morsels on an inner ring, biggest first from 12 o'clock
  const morsels: Morsel[] = useMemo(() => {
    const live = ORDER.map((k) => ({ k, n: snap.mix[k] ?? 0 })).filter((t) => t.n > 0);
    return live.map((t, i) => {
      const share = total ? t.n / total : 0;
      const f = (i + 0.5) / live.length;
      // two staggered rings, so the colony has to branch to reach them all instead of running one loop
      const rr = live.length > 1 ? (i % 2 ? 58 : 112) : 0;
      const [x, y] = pt(rr, f);
      return { k: t.k, n: t.n, share, x, y, r: 4 + 20 * Math.sqrt(share), rgb: hexRgb(colorOf(t.k)) };
    });
  }, [snap.mix, total]);

  // ─── the simulation ───
  const cv = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const sim = useRef<ReturnType<typeof makeSim> | null>(null);
  const seen = useRef(Date.now());
  // phones: the dish is drawn small, so rim labels break onto short lines in a bigger type and morsels show only their %
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setCompact(el.clientWidth < 520));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the morsels drift slowly round the dish and bounce off its wall and off each other. Positions only:
  // sizes, colours, counts and the NOT SEEN wall never change, and they never drift near the rim.
  const mg = useRef<(SVGGElement | null)[]>([]);
  const drift = useRef<Drift[]>([]);
  useEffect(() => {
    drift.current = morsels.map((m) => {
      const a = Math.random() * Math.PI * 2;
      const v = DRIFT_SPEED * (0.6 + Math.random() * 0.8);
      return { x: m.x, y: m.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: m.r, w: 0, h: 16, v };
    });
  }, [morsels]);
  // label widths follow the text actually shown (full names on desktop, % only on phones)
  useEffect(() => {
    drift.current.forEach((d, i) => {
      const m = morsels[i];
      if (!m) return;
      const lines = labelLines(m, compact);
      d.w = Math.max(...lines.map((l) => l.length)) * (compact ? 12.4 : 6.1) + 6;
      d.h = lines.length * (compact ? 22 : 11.5) + 4;
    });
  }, [morsels, compact]);

  useEffect(() => {
    const phone = (wrap.current?.clientWidth ?? 600) < 520;
    sim.current = makeSim(morsels, unseenFrom, phone ? 2600 : 6500);
  }, [morsels, unseenFrom]);

  useEffect(() => {
    sim.current?.setBias(picked === null ? -1 : morsels.findIndex((m) => m.k === picked));
  }, [picked, morsels]);

  // a live type change drops a speck of that type's colour
  useEffect(() => {
    for (const c of changes) {
      if (c.at <= seen.current) break;
      if (c.kind === 'new' || c.kind === 'flip') {
        const i = morsels.findIndex((m) => m.k === (c.to.primary ?? 'NONE'));
        if (i >= 0) sim.current?.speck(i);
      }
    }
    if (changes[0]) seen.current = Math.max(seen.current, changes[0].at);
  }, [changes, morsels]);

  useEffect(() => {
    const canvas = cv.current;
    if (!canvas) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let raf = 0;
    let last = 0;
    let frame = 0;
    let onScreen = true;
    const draw = () => {
      const S = sim.current;
      if (!S) return;
      const w = canvas.clientWidth;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      if (canvas.width !== Math.round(w * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(w * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = true;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(S.image(), 0, 0, canvas.width, canvas.height);
    };
    if (reduce) {
      // frozen: let it settle out of sight, then show one still frame
      for (let i = 0; i < 260; i++) sim.current?.step();
      draw();
      return;
    }
    for (let i = 0; i < 60; i++) sim.current?.step(); // don't open on an empty dish
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden || !onScreen) return;
      if (t - last < 33) return; // ≤ 30 fps
      const dt = last ? Math.min(0.1, (t - last) / 1000) : 0.033;
      last = t;
      frame++;
      stepDrift(drift.current, dt);
      drift.current.forEach((d, i) => placeMorsel(mg.current[i], d.x, d.y, d.r));
      sim.current?.move(drift.current, frame % 3 === 0);
      sim.current?.step();
      draw();
    };
    raf = requestAnimationFrame(loop);
    const io = new IntersectionObserver((e) => (onScreen = e[0]?.isIntersecting ?? true));
    io.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [morsels, unseenFrom]);

  const pickedM = picked ? morsels.find((m) => m.k === picked) ?? null : null;
  const scanAt = cov ? `full scan at block ${cov.block.toLocaleString('en-US')} · ${fmtAge(Date.parse(cov.at), now)} ago` : 'not measured yet: the next full scan measures it';
  const unseenTxt = (x: number | null | undefined) => (x !== null && x !== undefined && x < 0.9995 ? ` · ${((1 - x) * 100).toFixed(1)}% not seen` : '');
  const sw = snap.sweep;
  const disc = snap.discovery;

  // the SVG frame round the 400×400 dish: room for the callout columns on both sides
  const vb = compact ? ([-200, -46, 800, 516] as const) : ([-160, -34, 720, 468] as const);

  // ─── rim callouts ───
  // Nado's labels sit in a column beside the dish (left or right of the rim point they describe), stacked so they never
  // overlap, each with a thin leader line to its arc. Tydro's label stays at the top.
  const pctOf = (x: number) => `${(x * 100).toFixed(1)}%`;
  const depUnseen = 1 - depSeen;
  const callouts = useMemo(() => {
    if (!cov) return [];
    const items: { key: string; f: number; r: number; lines: string[]; cls: string; testid?: string }[] = [];
    items.push({ key: 'dep', f: Math.max(0.002, dep), r: R_DEP, cls: 'colony-rim-lbl', lines: compact ? ['DEPOSITS', `wallets ${pctOf(dep)}`] : ['NADO DEPOSITS', `wallets ${pctOf(dep)}`] });
    if (own > 0.0005) items.push({ key: 'own', f: (dep + depSeen) / 2, r: R_DEP, cls: 'colony-own-lbl', testid: 'rim-own-label', lines: compact ? ["NADO'S OWN", `vault ${pctOf(own)}`] : ["NADO'S OWN VAULT", `& accounts ${pctOf(own)}`] });
    items.push({ key: 'oi', f: Math.max(0.002, Math.max(oiL, oiS)), r: R_OI_L, cls: 'colony-rim-lbl', lines: compact ? ['OPEN INT.', `longs ${pctOf(oiL)}`, `shorts ${pctOf(oiS)}`] : ['NADO OPEN INTEREST', `longs ${pctOf(oiL)}`, `shorts ${pctOf(oiS)}`] });
    const ns = [
      ...(depUnseen > 0.0005 ? [`deposits ${pctOf(depUnseen)}`] : []),
      ...(oiL < 0.9995 ? [`longs ${pctOf(1 - oiL)}`] : []),
      ...(oiS < 0.9995 ? [`shorts ${pctOf(1 - oiS)}`] : []),
    ];
    if (ns.length) items.push({ key: 'ns', f: (unseenFrom + 1) / 2, r: DISH_R + 18, cls: 'colony-notseen', testid: 'not-seen-label', lines: ['NOT SEEN', ...ns] });
    const lh = compact ? 21 : 12.5;
    const top = vb[1] + lh + 4;
    const bottom = vb[1] + vb[3] - 6;
    const colL = compact ? -10 : -12;
    const colR = 410 + (compact ? 10 : 12);
    const out: { key: string; x: number; y: number; anchor: 'start' | 'end'; lines: string[]; cls: string; testid?: string; px: number; py: number; lx: number; ly: number }[] = [];
    for (const side of ['L', 'R'] as const) {
      const list = items
        .map((it) => {
          const [px, py] = pt(it.r + 3, it.f);
          return { ...it, px, py, h: it.lines.length * lh };
        })
        .filter((it) => (side === 'L' ? it.px < CX : it.px >= CX))
        .sort((p, q) => p.py - q.py);
      let y = top;
      const placed = list.map((it) => {
        const y0 = Math.max(it.py - it.h / 2, y);
        y = y0 + it.h + (compact ? 10 : 8);
        return { it, y0 };
      });
      // too low? slide the whole stack up
      const over = placed.length ? placed[placed.length - 1]!.y0 + placed[placed.length - 1]!.it.h - bottom : 0;
      for (const p of placed) {
        const y0 = over > 0 ? p.y0 - over : p.y0;
        const x = side === 'L' ? colL : colR;
        out.push({
          key: p.it.key, x, y: y0, anchor: side === 'L' ? 'end' : 'start', lines: p.it.lines, cls: p.it.cls, testid: p.it.testid,
          px: p.it.px, py: p.it.py, lx: side === 'L' ? x + 4 : x - 4, ly: y0 + p.it.h / 2 - lh * 0.35,
        });
      }
    }
    return out;
  }, [cov, compact, dep, own, depSeen, depUnseen, oiL, oiS, unseenFrom, vb]);

  return (
    <section className={`panel colony${compact ? ' compact' : ''}`} style={{ ['--rail' as string]: 'var(--cyan)' }} data-testid="colony">
      <div className="rail" aria-hidden />
      <div className="body">
        <h3 className="panel-title">
          The colony · position types and coverage
          <span className="right">decoration over real numbers · the agents are not wallets</span>
        </h3>
        <div className="colony-grid">
          <div className="colony-dish-col">
            <div className="colony-dish" ref={wrap} style={{ aspectRatio: `${vb[2]} / ${vb[3]}` }}>
              <canvas
                ref={cv}
                className="colony-canvas"
                style={{ left: `${(-vb[0] / vb[2]) * 100}%`, top: `${(-vb[1] / vb[3]) * 100}%`, width: `${(400 / vb[2]) * 100}%`, height: `${(400 / vb[3]) * 100}%` }}
                aria-hidden
              />
              <svg className="colony-svg" viewBox={vb.join(' ')} role="img" aria-label={`Coverage: Tydro supplied ${sharePct(s?.tydroSupply ?? null)}, borrowed ${sharePct(s?.tydroDebt ?? null)}; Nado deposits ${sharePct(s?.nadoDeposits ?? null)}; Nado open longs ${sharePct(s?.nadoOpenInterestLongs ?? null)}, shorts ${sharePct(s?.nadoOpenInterestShorts ?? null)}. The not-seen arcs stay dark.`}>
                <defs>
                  <pattern id="colony-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <line x1="0" y1="0" x2="0" y2="5" stroke="rgba(160,175,190,0.22)" strokeWidth="1" />
                  </pattern>
                </defs>
                <circle cx={CX} cy={CX} r={DISH_R} fill="none" stroke="var(--hair)" strokeWidth="1" />

                {/* NOT SEEN: the dark arcs, and the zone under them the colony is held out of */}
                {cov && anyUnseen ? (
                  <g data-testid="not-seen-zone" data-from={unseenFrom.toFixed(3)}>
                    <path d={sector(DARK_MAX + 2, DISH_R - 1, unseenFrom, 1)} fill="url(#colony-hatch)" stroke="none" />
                  </g>
                ) : null}

                {/* outer: Tydro supplied + borrowed */}
                <RimArc r={R_TYDRO + 2} w={2.5} share={s?.tydroSupply ?? null} id="tydro-supplied" />
                <RimArc r={R_TYDRO - 2} w={2.5} share={s?.tydroDebt ?? null} id="tydro-borrowed" />
                {/* middle: Nado deposits */}
                <RimArc r={R_DEP} w={5} share={s?.nadoDeposits ?? null} id="nado-deposits" own={own} />
                {/* inner: Nado open interest, longs + shorts */}
                <RimArc r={R_OI_L} w={2} share={s?.nadoOpenInterestLongs ?? null} id="nado-oi-longs" />
                <RimArc r={R_OI_S} w={2} share={s?.nadoOpenInterestShorts ?? null} id="nado-oi-shorts" />

                {/* rim labels — always on */}
                {compact ? (
                  <>
                    <Lines x={CX} y={-20} anchor="middle" cls="colony-rim-lbl" lines={[`TYDRO ${sharePct(s?.tydroSupply ?? null)} · ${sharePct(s?.tydroDebt ?? null)}`]} />
                    <Lines x={CX} y={0} anchor="middle" cls="colony-rim-sub" lines={['supplied · borrowed · outer rim']} />
                  </>
                ) : (
                  <>
                    <text x={CX} y={-14} textAnchor="middle" className="colony-rim-lbl">
                      TYDRO SUPPLIED {sharePct(s?.tydroSupply ?? null)} · BORROWED {sharePct(s?.tydroDebt ?? null)}
                    </text>
                    <text x={CX} y={-2} textAnchor="middle" className="colony-rim-sub">{cov && frac01(s?.tydroSupply) >= 0.9995 && frac01(s?.tydroDebt) >= 0.9995 ? 'outer rim · closed' : 'outer rim'}</text>
                  </>
                )}
                {cov ? (
                  <>
                    {callouts.map((c) => (
                      <g key={c.key}>
                        <polyline points={`${c.px.toFixed(1)},${c.py.toFixed(1)} ${c.lx.toFixed(1)},${c.ly.toFixed(1)}`} fill="none" stroke="rgba(160,175,190,0.32)" strokeWidth="1" />
                        <Lines x={c.x} y={c.y + (compact ? 16 : 9.5)} anchor={c.anchor} cls={c.cls} testid={c.testid} lines={c.lines} />
                      </g>
                    ))}
                  </>
                ) : (
                  <Lines x={CX} y={418} anchor="middle" cls="colony-notseen" lines={compact ? ['NADO COVERAGE NOT MEASURED', 'RIM DARK'] : ['NADO COVERAGE NOT MEASURED YET · RIM DARK']} />
                )}

                {/* food morsels */}
                {morsels.map((m, i) => {
                  const on = picked === null || picked === m.k;
                  const toggle = () => setPicked((p) => (p === m.k ? null : m.k));
                  const { lx, ly } = labelAt(m.x, m.y, m.r);
                  return (
                    <g
                      key={m.k}
                      ref={(el) => {
                        mg.current[i] = el;
                      }}
                      role="button"
                      tabIndex={0}
                      aria-pressed={picked === m.k}
                      aria-label={`${nameOf(m.k)}: ${m.n.toLocaleString('en-US')} wallets`}
                      className="colony-morsel"
                      data-testid="colony-morsel"
                      data-type={m.k}
                      onClick={toggle}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggle();
                        }
                      }}
                    >
                      <circle cx={m.x} cy={m.y} r={m.r} fill={colorOf(m.k)} fillOpacity={on ? 0.85 : 0.25} stroke={picked === m.k ? 'var(--ink)' : 'none'} strokeWidth="1.5" />
                      <circle cx={m.x} cy={m.y} r={Math.max(m.r, 12)} fill="transparent" />
                      <text x={lx} y={ly + 3} textAnchor="middle" className="colony-morsel-lbl">
                        {labelLines(m, compact).map((l, j) => (
                          <tspan key={j} x={lx} dy={j ? '1.1em' : 0} className={j ? 'pct' : undefined}>
                            {l}
                          </tspan>
                        ))}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
            <div className="colony-pick mono" data-testid="colony-pick">
              {pickedM ? (
                <>
                  <i style={{ background: colorOf(pickedM.k) }} aria-hidden />
                  {nameOf(pickedM.k)} · {pickedM.n.toLocaleString('en-US')} wallets · {(pickedM.share * 100).toFixed(1)}% of drawn
                  <button type="button" className="sq-btn" onClick={() => setPicked(null)} style={{ marginLeft: 10 }}>Clear</button>
                </>
              ) : (
                <span className="faint">Click a morsel (or a type in the list) and the colony leans toward it.</span>
              )}
            </div>
            <ul className="colony-limits dim" data-testid="colony-limits">
              <li>Counts wallets, not money. A $5 account and a $5M account each count once.</li>
              <li>Nado isolated-margin positions are found from every trade since launch.</li>
              <li>Wallets near danger, Tydro borrowers and anything that moved are re-read every hour, and live while the well is open. Quiet, healthy wallets are re-read in the weekly full scan.</li>
            </ul>
            <div className="faint mono colony-note">Counts wallets, not money. Not advice.</div>
          </div>

          <div className="colony-read" data-testid="colony-readout">
            <div className="scan-cap">COVERAGE · {scanAt}</div>
            <dl className="kv tight">
              <dt>tydro supplied</dt><dd className="num" data-testid="cov-tydro-supplied">{sharePct(s?.tydroSupply ?? null)}</dd>
              <dt>tydro borrowed</dt><dd className="num" data-testid="cov-tydro-borrowed">{sharePct(s?.tydroDebt ?? null)}</dd>
              <dt>nado deposits</dt><dd className="num" data-testid="cov-nado-deposits">{sharePct(s?.nadoDeposits ?? null)}<span className="faint">{own > 0.0005 ? ` · ${pctOf(own)} Nado's own vault` : ''}{cov ? unseenTxt(depSeen) : ''}</span></dd>
              <dt>nado open longs</dt><dd className="num" data-testid="cov-nado-longs">{sharePct(s?.nadoOpenInterestLongs ?? null)}<span className="faint">{unseenTxt(s?.nadoOpenInterestLongs)}</span></dd>
              <dt>nado open shorts</dt><dd className="num" data-testid="cov-nado-shorts">{sharePct(s?.nadoOpenInterestShorts ?? null)}<span className="faint">{unseenTxt(s?.nadoOpenInterestShorts)}</span></dd>
            </dl>

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

            <div className="scan-cap" style={{ marginTop: 14 }}>POSITION TYPES · share of drawn wallets</div>
            <ul className="colony-types" data-testid="colony-types">
              {ORDER.filter((k) => (snap.mix[k] ?? 0) > 0).map((k) => {
                const n = snap.mix[k] ?? 0;
                return (
                  <li key={k}>
                    <button type="button" className={`colony-type${picked === k ? ' on' : ''}`} onClick={() => setPicked((p) => (p === k ? null : k))}>
                      <i style={{ background: colorOf(k) }} aria-hidden />
                      <span>{nameOf(k)}</span>
                      <b className="num">{n.toLocaleString('en-US')}</b>
                      <span className="num faint">{total ? ((n / total) * 100).toFixed(1) : '0.0'}%</span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="scan-cap" style={{ marginTop: 14 }}>LAST SCAN</div>
            <dl className="kv tight" data-testid="colony-last-scan">
              <dt>block</dt><dd className="num">{snap.block.toLocaleString('en-US')}</dd>
              <dt>age</dt><dd className="mono">{fmtAge(Date.parse(snap.generatedAt), now)} ago</dd>
              <dt>type</dt><dd className="mono">{sw.kind === 'full' ? 'full re-read' : 'hourly'}{sw.complete === false ? ' (partial — continues next run)' : ''}</dd>
              <dt>re-read</dt><dd className="num">{sw.reread.toLocaleString('en-US')} wallets</dd>
              <dt>kept from earlier</dt><dd className="num">{sw.carried.toLocaleString('en-US')} wallets</dd>
              <dt>took</dt><dd className="num">{Math.round(sw.ms / 1000)} s</dd>
              <dt>history</dt>
              <dd className="mono">
                {disc.backfillComplete
                  ? 'complete — every Tydro and Nado wallet since launch'
                  : `backfilling — Tydro to ${disc.tydroScannedTo.toLocaleString('en-US')}, Nado to ${disc.nadoScannedTo.toLocaleString('en-US')} of ${disc.head.toLocaleString('en-US')}`}
              </dd>
              <dt>rules</dt><dd className="mono">{snap.rulesVersion}</dd>
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}

/** desktop: name over percent; phones: percent only (the names are in the type list right below) */
const labelLines = (m: Morsel, compact: boolean) => (compact ? [`${(m.share * 100).toFixed(1)}%`] : [nameOf(m.k), `${(m.share * 100).toFixed(1)}%`]);

/* ─── morsel drift ─── */
const DRIFT_SPEED = 9; // dish units per second
const DRIFT_WALL = 136; // dot edges stay inside this radius: clear of the NOT SEEN sector (from 148) and the rim
const PAD = 4; // breathing room between two morsels' boxes

type Drift = { x: number; y: number; vx: number; vy: number; r: number; w: number; h: number; v: number };

/**
 * Each morsel is a box: its dot with its label centred underneath. Boxes bounce off each other (equal-mass, on the
 * axis they overlap least), so no two labels ever sit on top of one another; dots bounce off the dish wall.
 */
function stepDrift(ds: Drift[], dt: number) {
  for (const d of ds) {
    // a slow wander, back to cruising speed: crowding never settles into a standstill
    const a = Math.atan2(d.vy, d.vx) + (Math.random() - 0.5) * 0.6 * dt * 10;
    const sp = Math.hypot(d.vx, d.vy);
    const ns = sp + (d.v - sp) * Math.min(1, dt * 1.5);
    d.vx = Math.cos(a) * ns;
    d.vy = Math.sin(a) * ns;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    const dx = d.x - CX, dy = d.y - CX;
    const dist = Math.hypot(dx, dy);
    const lim = DRIFT_WALL - d.r;
    if (dist > lim && dist > 0) {
      const nx = dx / dist, ny = dy / dist;
      d.x = CX + nx * lim;
      d.y = CX + ny * lim;
      const dot = d.vx * nx + d.vy * ny;
      if (dot > 0) (d.vx -= 2 * dot * nx), (d.vy -= 2 * dot * ny);
    }
    // the label must not run off the dish sideways either
    const half = Math.max(d.r, d.w / 2);
    const xl = Math.sqrt(Math.max(0, (DRIFT_WALL + 14) ** 2 - (d.y - CX) ** 2)) + 10;
    if (d.x - half < CX - xl) (d.x = CX - xl + half), (d.vx = Math.abs(d.vx));
    if (d.x + half > CX + xl) (d.x = CX + xl - half), (d.vx = -Math.abs(d.vx));
  }
  for (let i = 0; i < 2; i++)
    for (let a = 0; a < ds.length; a++)
      for (let b = a + 1; b < ds.length; b++) {
        const A = ds[a]!, B = ds[b]!;
        const ax = A.x, ay = A.y + A.h / 2, bx = B.x, by = B.y + B.h / 2; // box centres (dot + label under it)
        const ox = (Math.max(2 * A.r, A.w) + Math.max(2 * B.r, B.w)) / 2 + PAD - Math.abs(bx - ax);
        const oy = (2 * A.r + A.h + 2 * B.r + B.h) / 2 + PAD - Math.abs(by - ay);
        if (ox <= 0 || oy <= 0) continue;
        if (ox < oy) {
          const s = bx >= ax ? 1 : -1;
          A.x -= (s * ox) / 2;
          B.x += (s * ox) / 2;
          if ((B.vx - A.vx) * s < 0) [A.vx, B.vx] = [B.vx, A.vx];
        } else {
          const s = by >= ay ? 1 : -1;
          A.y -= (s * oy) / 2;
          B.y += (s * oy) / 2;
          if ((B.vy - A.vy) * s < 0) [A.vy, B.vy] = [B.vy, A.vy];
        }
      }
}

/** where a morsel's label goes: centred under its dot */
const labelAt = (x: number, y: number, r: number) => ({ lx: x, ly: y + r + 12 });

/** move one morsel's SVG (dot, hit area, label) without a React render */
function placeMorsel(g: SVGGElement | null | undefined, x: number, y: number, r: number) {
  if (!g) return;
  const [c0, c1] = g.querySelectorAll('circle');
  for (const c of [c0, c1]) {
    c?.setAttribute('cx', x.toFixed(1));
    c?.setAttribute('cy', y.toFixed(1));
  }
  const t = g.querySelector('text');
  if (!t) return;
  const { lx, ly } = labelAt(x, y, r);
  t.setAttribute('x', lx.toFixed(1));
  t.setAttribute('y', (ly + 3).toFixed(1));
  t.querySelectorAll('tspan').forEach((ts) => ts.setAttribute('x', lx.toFixed(1)));
}

/** SVG text over one or more lines (the first line sits at y) */
function Lines({ x, y, anchor, cls, lines, testid }: { x: number; y: number; anchor: 'start' | 'middle' | 'end'; cls: string; lines: string[]; testid?: string }) {
  return (
    <text x={x} y={y} textAnchor={anchor} className={cls} data-testid={testid}>
      {lines.map((l, i) => (
        <tspan key={i} x={x} dy={i ? '1.15em' : 0}>
          {l}
        </tspan>
      ))}
    </text>
  );
}

/** One coverage mark on the rim: lit arc from 12 o'clock for the share seen, a dark track for the rest. */
function RimArc({ r, w, share, id, own = 0 }: { r: number; w: number; share: number | null; id: string; own?: number }) {
  const f0 = frac01(share);
  const f = Math.min(1, f0 + own); // seen = wallets + Nado's own accounts
  return (
    <g data-testid={`rim-${id}`} data-share={share === null ? '' : share.toFixed(4)}>
      {f < 0.9995 ? (
        // the NOT SEEN remainder: dark, dashed, never lit
        <path d={f > 0 ? arc(r, f, 1) : arc(r, 0, 0.99999)} fill="none" stroke="rgba(160,175,190,0.28)" strokeWidth={w} strokeDasharray="1.5 3" data-testid={`rim-${id}-dark`} />
      ) : null}
      {f0 > 0 ? <path d={f0 >= 0.9995 ? arc(r, 0, 0.99999) : arc(r, 0, f0)} fill="none" stroke="var(--cyan)" strokeWidth={w} data-testid={`rim-${id}-lit`} /> : null}
      {own > 0.0005 ? (
        // seen, but held by Nado itself, not by wallets: same rim, a quieter colour
        <path d={arc(r, f0, f)} fill="none" stroke="rgba(160,175,190,0.6)" strokeWidth={w} data-testid={`rim-${id}-own`} />
      ) : null}
    </g>
  );
}

/* ───────────────────────── the simulation (pure, no React) ───────────────────────── */

function makeSim(morsels: Morsel[], unseenFrom: number, count: number) {
  const N = G * G;
  const S = new Float32Array(N); // scent the agents follow (all trails)
  const R = new Float32Array(N);
  const Gc = new Float32Array(N);
  const B = new Float32Array(N);
  const F = new Float32Array(N); // food scent from the morsels
  const tmp = new Float32Array(N);
  const c = G / 2;
  const litMax = LIT_MAX / CELL;
  const darkMax = DARK_MAX / CELL;
  const dishR = DISH_R / CELL;
  let bias = -1;

  // agents: x, y, heading, colour (morsel index)
  const ax = new Float32Array(count);
  const ay = new Float32Array(count);
  const ah = new Float32Array(count);
  const ac = new Int16Array(count);
  const weights = morsels.map((m) => m.share);
  const pick = () => {
    let r = Math.random() * (weights.reduce((a, b) => a + b, 0) || 1);
    for (let i = 0; i < weights.length; i++) if ((r -= weights[i]!) <= 0) return i;
    return Math.max(0, weights.length - 1);
  };
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * darkMax * 0.9;
    ax[i] = c + r * Math.cos(a);
    ay[i] = c + r * Math.sin(a);
    ah[i] = Math.random() * Math.PI * 2;
    ac[i] = morsels.length ? pick() : 0;
  }
  const pickFed = () => {
    const w = weights.map((x, k) => Math.sqrt(x) * (k === bias ? 4 : 1));
    let r = Math.random() * (w.reduce((a, b) => a + b, 0) || 1);
    for (let k = 0; k < w.length; k++) if ((r -= w[k]!) <= 0) return k;
    return Math.max(0, w.length - 1);
  };
  const mc = morsels.map((m) => ({ x: m.x / CELL, y: m.y / CELL, r: m.r / CELL, rgb: m.rgb, w: Math.sqrt(m.share) }));

  const buildFood = () => {
    F.fill(0);
    mc.forEach((m, k) => {
      const amp = (0.6 + 3 * m.w) * (k === bias ? 4 : 1);
      const sig = m.r * 1.6 + 6;
      const reach = Math.ceil(sig * 3);
      for (let y = Math.max(0, Math.floor(m.y - reach)); y < Math.min(G, m.y + reach); y++)
        for (let x = Math.max(0, Math.floor(m.x - reach)); x < Math.min(G, m.x + reach); x++) {
          const d2 = (x - m.x) ** 2 + (y - m.y) ** 2;
          F[y * G + x]! += amp * Math.exp(-d2 / (2 * sig * sig));
        }
    });
  };
  buildFood();

  /** how far from the centre the colony may be at this cell: less under a NOT SEEN arc */
  const maxR = (dx: number, dy: number) => (turnOf(dx, dy) >= unseenFrom ? darkMax : litMax);
  const inside = (x: number, y: number) => {
    const dx = x - c, dy = y - c;
    return Math.hypot(dx, dy) < maxR(dx, dy);
  };
  const FOOD = 0.9; // how hard the food pulls compared with the trails
  const scent = (x: number, y: number) => {
    const ix = x | 0, iy = y | 0;
    if (ix < 0 || iy < 0 || ix >= G || iy >= G || !inside(x, y)) return -1;
    const i = iy * G + ix;
    return S[i]! + FOOD * F[i]!;
  };

  const SA = 0.7, SD = 9, TURN = 0.45, STEP = 0.9, DEP = 1;
  // diffuse half-way toward the 3×3 mean, then decay: keeps veins thin instead of blooming into a blob
  const blur = (a: Float32Array, decay: number) => {
    for (let y = 1; y < G - 1; y++) {
      const o = y * G;
      for (let x = 1; x < G - 1; x++) {
        const i = o + x;
        const mean = (a[i - G - 1]! + a[i - G]! + a[i - G + 1]! + a[i - 1]! + a[i]! + a[i + 1]! + a[i + G - 1]! + a[i + G]! + a[i + G + 1]!) / 9;
        tmp[i] = (a[i]! * 0.5 + mean * 0.5) * decay;
      }
    }
    a.set(tmp);
  };

  const step = () => {
    for (let i = 0; i < count; i++) {
      // every morsel keeps sending out a few agents, in proportion to its share: no type goes unfed
      if (mc.length && Math.random() < 0.014) {
        const k = pickFed();
        const m = mc[k]!;
        const a = Math.random() * Math.PI * 2;
        ax[i] = m.x + Math.cos(a) * (m.r + 1);
        ay[i] = m.y + Math.sin(a) * (m.r + 1);
        ah[i] = a;
        ac[i] = k;
      }
      const x = ax[i]!, y = ay[i]!, h = ah[i]!;
      const l = scent(x + Math.cos(h - SA) * SD, y + Math.sin(h - SA) * SD);
      const f = scent(x + Math.cos(h) * SD, y + Math.sin(h) * SD);
      const r = scent(x + Math.cos(h + SA) * SD, y + Math.sin(h + SA) * SD);
      let nh = h;
      if (f >= l && f >= r) nh += (Math.random() - 0.5) * 0.5;
      else if (l > r) nh -= TURN * (0.6 + Math.random() * 0.4);
      else if (r > l) nh += TURN * (0.6 + Math.random() * 0.4);
      else nh += (Math.random() - 0.5) * TURN * 2;
      const nx = x + Math.cos(nh) * STEP, ny = y + Math.sin(nh) * STEP;
      if (!inside(nx, ny)) {
        ah[i] = nh + Math.PI + (Math.random() - 0.5) * 1.2; // bounce off the rim — never into a NOT SEEN arc
        continue;
      }
      ax[i] = nx;
      ay[i] = ny;
      ah[i] = nh;
      // touching a morsel takes on its colour
      for (let k = 0; k < mc.length; k++) {
        const m = mc[k]!;
        if ((nx - m.x) ** 2 + (ny - m.y) ** 2 < (m.r + 1.5) ** 2) {
          ac[i] = k;
          break;
        }
      }
      const j = (ny | 0) * G + (nx | 0);
      const rgb = mc[ac[i]!]?.rgb ?? [0.6, 0.65, 0.7];
      S[j]! += DEP;
      R[j]! += DEP * rgb[0];
      Gc[j]! += DEP * rgb[1];
      B[j]! += DEP * rgb[2];
    }
    blur(S, 0.91);
    blur(R, 0.91);
    blur(Gc, 0.91);
    blur(B, 0.91);
  };

  const off = document.createElement('canvas');
  off.width = G;
  off.height = G;
  const octx = off.getContext('2d')!;
  const img = octx.createImageData(G, G);
  const image = () => {
    const d = img.data;
    // exposure follows the colony: brightness is relative to the densest veins, so it never washes out to white
    let sum = 0;
    let lit = 0;
    for (let i = 0; i < N; i++) if (S[i]! > 0.05) (sum += S[i]!), lit++;
    const ref = Math.max(0.5, (lit ? sum / lit : 1) * 1.6);
    for (let y = 0; y < G; y++)
      for (let x = 0; x < G; x++) {
        const i = y * G + x;
        const p = i * 4;
        const dist = Math.hypot(x + 0.5 - c, y + 0.5 - c);
        const sv = S[i]!;
        if (dist > dishR || sv < 0.02) {
          d[p + 3] = 0;
          continue;
        }
        const b = 1 - Math.exp(-sv / ref); // 0..1 brightness
        const inv = 1 / sv; // the trail's own colour: the mix of the types that laid it
        d[p] = 255 * Math.min(1, R[i]! * inv) * b;
        d[p + 1] = 255 * Math.min(1, Gc[i]! * inv) * b;
        d[p + 2] = 255 * Math.min(1, B[i]! * inv) * b;
        d[p + 3] = 255 * Math.min(1, b * 1.4);
      }
    octx.putImageData(img, 0, 0);
    return off;
  };

  return {
    step,
    image,
    /** the morsels drifted: move their touch zones every frame, their food scent when asked */
    move(pos: readonly { x: number; y: number }[], food: boolean) {
      pos.forEach((p, k) => {
        const m = mc[k];
        if (m) (m.x = p.x / CELL), (m.y = p.y / CELL);
      });
      if (food) buildFood();
    },
    setBias(i: number) {
      bias = i;
      buildFood();
    },
    /** a live type change: one bright speck on that type's morsel */
    speck(k: number) {
      const m = mc[k];
      if (!m) return;
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const x = (m.x + dx) | 0, y = (m.y + dy) | 0;
          if (x < 0 || y < 0 || x >= G || y >= G) continue;
          const j = y * G + x;
          const a = 12 * Math.exp(-(dx * dx + dy * dy) / 4);
          S[j]! += a;
          R[j]! += a * m.rgb[0];
          Gc[j]! += a * m.rgb[1];
          B[j]! += a * m.rgb[2];
        }
    },
  };
}
