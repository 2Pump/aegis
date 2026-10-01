import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CENTRE_LABEL, RISK_LABEL, SIZE_LABEL, SPHERE_BAND_W, VIEW_LABEL, seatSphere, type SphereLod, type SphereSeat } from '@aegis/glyphs';
import { TagChip } from '../bits';
import { ShipList, type WellShip } from '../Well';
import type { SphereEngine } from './engine';

const SIZE_KEY: Array<[keyof typeof SPHERE_BAND_W, string]> = [
  ['100k+', '$100K+'],
  ['10–100k', '$10–100K'],
  ['1–10k', '$1–10K'],
  ['<1k', '<$1K'],
];
const FLASH_WINDOW_MS = 1500;
/** A data change touching at most this many wallets is a live update (deferred while moving, spaced out on phones). */
const LIVE_DELTA_MAX = 25;
/** Phones: at most one live rebuild of the sphere every 8 s. */
const PHONE_LIVE_GAP_MS = 8000;

/**
 * HULL SPHERE — the well as a glass world. Longitude = main-pose lune, depth = risk, size = band, red ring = WOUNDED.
 * The three.js engine loads only when this view is shown. Filters, Find, the hull links and the list view work as before;
 * nothing on the sphere carries a balance, a health number or a liquidation price.
 */
function HullSphere({
  ships,
  onOpen,
  found = null,
  resetKey = '',
}: {
  ships: WellShip[];
  onOpen: (href: string) => void;
  found?: string | null;
  resetKey?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<SphereEngine | null>(null);
  const [w, setW] = useState(0);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [hud, setHud] = useState<{ text: string; lod: SphereLod; pivot: 'CORE' | 'HULL' | 'POINT' }>({ text: 'AZ ---°  EL --°  DEPTH -.--  ZOOM 1.0×', lod: 'MANTLE', pivot: 'CORE' });
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const [framed, setFramed] = useState<{ i: number; x: number; y: number } | null>(null);
  // ?fps=1: on-page frame counter for checking the budget on a real laptop / phone (counts frames actually drawn)
  const showFps = useMemo(() => new URLSearchParams(window.location.search).get('fps') === '1', []);
  const [fps, setFps] = useState<{ fps: number; calls: number } | null>(null);

  const phone = w > 0 && w < 560;
  const h = w ? (phone ? Math.round(w * 1.05) : Math.round(Math.min(w * 0.64, 740))) : 0;

  // seats cached per address: a new block refreshes "read N ago" text, it never re-seats the world
  const cache = useRef(new Map<string, { sig: string; seat: SphereSeat; ref: WellShip }>());
  const layout = useRef<{ seats: SphereSeat[]; refs: WellShip[]; delta: number } | null>(null);
  const world = useMemo(() => {
    const prev = cache.current;
    const next = new Map<string, { sig: string; seat: SphereSeat; ref: WellShip }>();
    let changed = layout.current === null || ships.length !== prev.size;
    let delta = layout.current === null ? Infinity : Math.abs(ships.length - prev.size);
    for (const s of ships) {
      const sig = `${s.primary}|${s.tags.join(',')}|${s.hullTemp}|${s.band}|${s.focused ? 1 : 0}`;
      const p = prev.get(s.address);
      if (p && p.sig === sig) {
        p.ref = s; // fresh meta / flash for the tooltip, same seat
        next.set(s.address, p);
      } else {
        changed = true;
        delta++;
        next.set(s.address, { sig, seat: seatSphere(s), ref: s });
      }
    }
    cache.current = next;
    if (!changed && layout.current) {
      layout.current.refs = [...next.values()].map((v) => v.ref);
      return layout.current;
    }
    const vals = [...next.values()];
    layout.current = { seats: vals.map((v) => v.seat), refs: vals.map((v) => v.ref), delta };
    return layout.current;
  }, [ships]);
  /*
   * The world the engine is actually drawing. Live updates (a handful of wallets) never land mid-gesture — they wait
   * until the camera rests — and on phones at most every few seconds, because each one rebuilds the GPU buffers.
   * A filter change (many wallets) lands at once. Every index (hover, plate, find, flash) refers to this world.
   */
  const [applied, setApplied] = useState(world);
  const pendingWorld = useRef<typeof world | null>(null);
  const lastApply = useRef(0);
  const applyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    const next = pendingWorld.current;
    if (!next) return;
    if (engine.current?.isMoving()) return; // onSettle calls back
    const small = next.delta <= LIVE_DELTA_MAX;
    const wait = small && phone ? PHONE_LIVE_GAP_MS - (Date.now() - lastApply.current) : 0;
    if (wait > 0) {
      if (!applyTimer.current)
        applyTimer.current = setTimeout(() => {
          applyTimer.current = null;
          flushRef.current();
        }, wait);
      return;
    }
    pendingWorld.current = null;
    lastApply.current = Date.now();
    setApplied(next);
  };
  useEffect(() => {
    if (world === applied) return; // same seats (only "read N ago" text changed in place)
    pendingWorld.current = world;
    flushRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world]);
  useEffect(() => () => {
    if (applyTimer.current) clearTimeout(applyTimer.current);
  }, []);

  const refsRef = useRef(applied.refs);
  refsRef.current = applied.refs;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const foundIdx = useMemo(() => (found ? applied.seats.findIndex((s) => s.address === found) : -1), [applied, found]);

  // size
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setW(Math.round(el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // engine: loaded on demand; rebuilt only if the phone/desktop budget changes
  useEffect(() => {
    if (!w || !host.current) return;
    let alive = true;
    let eng: SphereEngine | null = null;
    import('./engine')
      .then(({ SphereEngine, webglAvailable }) => {
        if (!alive || !host.current) return;
        if (!webglAvailable()) throw new Error('WebGL is not available in this browser');
        eng = new SphereEngine(
          host.current,
          {
            onHud: (text, lod, pivot) => setHud({ text, lod, pivot }),
            onHover: (i, x, y) => setHover(i === null ? null : { i, x, y }),
            onOpen: (i) => {
              const r = refsRef.current[i];
              if (r) onOpenRef.current(r.href);
            },
            ...(showFps ? { onFps: (f: number, calls: number) => setFps({ fps: f, calls }) } : {}),
            onSettle: () => flushRef.current(),
            onFramed: (i, x, y) =>
              setFramed((prev) => (i === null ? null : prev && prev.i === i && Math.abs(prev.x - x) < 0.5 && Math.abs(prev.y - y) < 0.5 ? prev : { i, x, y })),
          },
          { phone, reduceMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false },
        );
        engine.current = eng;
        setReady(true);
      })
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
      eng?.dispose();
      engine.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone, w > 0]);

  useEffect(() => {
    if (ready && w && h) engine.current?.resize(w, h);
  }, [ready, w, h]);

  // data → engine (layout changes only)
  useEffect(() => {
    if (!ready) return;
    engine.current?.setSeats(applied.seats); // the engine keeps the framed hull by address
    setHover(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, applied.seats]);

  // filter change → home (with a short fade); Find → frame the hull
  const firstReset = useRef(true);
  useEffect(() => {
    if (!ready) return;
    const e = engine.current;
    if (!e) return;
    if (foundIdx >= 0) e.frame(foundIdx);
    else e.goHome(!firstReset.current);
    if (!firstReset.current && host.current) {
      host.current.classList.remove('hs-fade');
      void host.current.offsetWidth;
      host.current.classList.add('hs-fade');
    }
    firstReset.current = false;
    // keyed on the ADDRESS: a live update that shifts indices must not pull the camera back to the hull
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, resetKey, found, foundIdx >= 0]);

  // one ember per live change
  const flashKey = useMemo(() => {
    let m = 0;
    for (const s of ships) if (s.flashAt && s.flashAt > m) m = s.flashAt;
    return m;
  }, [ships]);
  useEffect(() => {
    if (!ready || !flashKey) return;
    const now = Date.now();
    const idx: number[] = [];
    applied.refs.forEach((r, i) => {
      if (r.flashAt && now - r.flashAt < FLASH_WINDOW_MS) idx.push(i);
    });
    engine.current?.flash(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, flashKey, applied]);

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const eng = engine.current;
    if (!eng) return;
    const k = e.key;
    if (k === 'ArrowLeft') eng.orbitBy(-12);
    else if (k === 'ArrowRight') eng.orbitBy(12);
    else if (k === '+' || k === '=') eng.zoomBy(1.4);
    else if (k === '-' || k === '_') eng.zoomBy(1 / 1.4);
    else if (k === '0' || k === 'Escape') eng.goHome();
    else if (k === 'f' || k === 'F') {
      if (!eng.frameHovered() && foundIdx >= 0) eng.frame(foundIdx); // F with nothing under the pointer re-frames the found hull
    }
    else return;
    e.preventDefault();
  };

  const tipShip = hover ? applied.refs[hover.i] : undefined;
  const plateShip = framed ? applied.refs[framed.i] : undefined;
  const sizeKey = (
    <div className="wg-key" aria-label="Size key: glyph size is the wallet's size">
      <div className="wg-key-h">WALLET SIZE</div>
      {SIZE_KEY.map(([b, t]) => (
        <div key={b} className="wg-key-row">
          <i style={{ width: SPHERE_BAND_W[b] * 640, height: SPHERE_BAND_W[b] * 640 }} />
          <span>{t}</span>
        </div>
      ))}
      <div className="wg-key-row">
        <i className="ring" />
        <span>NEAR LIQUIDATION</span>
      </div>
    </div>
  );

  return (
    <div className="stack" style={{ gap: 10 }} ref={wrap}>
      {failed ? (
        <div className="banner" data-testid="sphere-failed">The sphere could not start ({failed}). Pick 2D above to see the well.</div>
      ) : null}
      <div
        ref={host}
        className={`wg hs${phone ? ' phone' : ''}`}
        style={{ height: h || undefined }}
        tabIndex={0}
        role="application"
        aria-label={`Well, sphere view. ${ships.length} wallets. Drag to rotate, plus and minus to zoom, 0 to reset, F to focus a wallet.`}
        onKeyDown={onKey}
        data-testid="hull-sphere"
      >
        {!ready && !failed ? <div className="hs-loading">LOADING THE SPHERE…</div> : null}
        <div className="wg-hud tl">
          <span className="hs-title">THE WELL · SPHERE</span>
          {'\n'}VIEW  {VIEW_LABEL[hud.lod]}
          {'\n'}CENTRED ON  {CENTRE_LABEL[hud.pivot]}
          {fps ? `\nFPS  ${fps.fps}  ·  DRAW CALLS ${fps.calls}  ·  ${ships.length.toLocaleString('en-US')} WALLETS` : ''}
        </div>
        {!phone ? (
          <>
            <div className="wg-hud tr">{sizeKey}</div>
            <div className="wg-hud bl" data-testid="sphere-hud">{hud.text}</div>
          </>
        ) : null}
        <div className="wg-hud br wg-zoom" role="group" aria-label="Camera">
          <button type="button" onClick={() => engine.current?.zoomBy(1.6)} aria-label="Zoom in">+</button>
          <button type="button" onClick={() => engine.current?.zoomBy(1 / 1.6)} aria-label="Zoom out">−</button>
          <button type="button" onClick={() => engine.current?.goHome()} aria-label="Reset view">0</button>
        </div>
        {tipShip && hover && (!framed || framed.i !== hover.i) ? (
          <div className="well-tip" style={{ left: Math.max(4, Math.min(hover.x, w - 210)), top: Math.min(hover.y, h - 100) }}>
            <div className="tags">
              <TagChip tag={tipShip.primary} />
              {tipShip.tags.includes('WOUNDED') && tipShip.primary !== 'WOUNDED' ? <TagChip tag="WOUNDED" /> : null}
            </div>
            <div style={{ marginTop: 6 }}>{tipShip.label ?? `${tipShip.address.slice(0, 6)}…${tipShip.address.slice(-4)}`}</div>
            <div className="dim">size {SIZE_LABEL[tipShip.band]} · risk {RISK_LABEL[tipShip.hullTemp]}</div>
            {tipShip.meta ? <div className="faint">{tipShip.meta()}</div> : null}
            {phone ? <div className="faint">tap again to open</div> : null}
          </div>
        ) : null}
        {plateShip && framed ? (
          <div className="hs-plate" style={{ left: Math.max(6, Math.min(framed.x + 46, w - 236)), top: Math.max(6, Math.min(framed.y - 70, h - 130)) }} data-testid="sphere-plate">
            <div className="tags">
              <TagChip tag={plateShip.primary} />
              {plateShip.tags.includes('WOUNDED') && plateShip.primary !== 'WOUNDED' ? <TagChip tag="WOUNDED" /> : null}
            </div>
            <div style={{ marginTop: 6 }}>{plateShip.address.slice(0, 6)}…{plateShip.address.slice(-4)}</div>
            <div className="dim">risk {RISK_LABEL[plateShip.hullTemp]} · size {SIZE_LABEL[plateShip.band]}</div>
            <button type="button" className="sq-btn" style={{ marginTop: 8 }} onClick={() => onOpen(plateShip.href)}>
              OPEN WALLET →
            </button>
          </div>
        ) : null}
      </div>
      {phone ? (
        <div className="wg-strip">
          <span data-testid="sphere-hud">{hud.text}</span>
          <span>VIEW {VIEW_LABEL[hud.lod]} · CENTRED ON {CENTRE_LABEL[hud.pivot]}</span>
          {sizeKey}
        </div>
      ) : null}
      <div className="legend wg-legend" aria-hidden>
        <span>COLOUR BAND = POSITION TYPE</span>
        <span>DEPTH = RISK · SAFE (OUTSIDE) / WATCH / NEAR LIQUIDATION (CORE)</span>
        <span>SIZE = WALLET SIZE</span>
        <span className="red">RED RING = NEAR LIQUIDATION</span>
        <span className="faint">THREADS = SAME TYPE, NEARBY · DECORATION ONLY</span>
        <span className="faint">DRAG ORBIT · WHEEL / PINCH ZOOM · RIGHT-DRAG PAN · F FRAME · 0 RESET</span>
      </div>
      <ShipList ships={ships} onOpen={onOpen} />
    </div>
  );
}

/** memo: Home re-renders for its own reasons (filters, tapes); the sphere only cares when its props change */
export default memo(HullSphere);
