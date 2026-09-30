import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SPHERE_BAND_W, seatSphere, type SphereLod, type SphereSeat } from '@aegis/glyphs';
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

/**
 * HULL SPHERE — the well as a glass world. Longitude = main-pose lune, depth = risk, size = band, red ring = WOUNDED.
 * The three.js engine loads only when this view is shown. Filters, Find, the hull links and the list view work as before;
 * nothing on the sphere carries a balance, a health number or a liquidation price.
 */
export default function HullSphere({
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
  const [hud, setHud] = useState<{ text: string; lod: SphereLod }>({ text: 'AZ ---°  EL --°  R -.--  ZOOM 1.0×', lod: 'MANTLE' });
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const [framed, setFramed] = useState<{ i: number; x: number; y: number } | null>(null);
  // ?fps=1: on-page frame counter for checking the budget on a real laptop / phone (counts frames actually drawn)
  const showFps = useMemo(() => new URLSearchParams(window.location.search).get('fps') === '1', []);
  const [fps, setFps] = useState<{ fps: number; calls: number } | null>(null);

  const phone = w > 0 && w < 560;
  const h = w ? (phone ? Math.round(w * 1.05) : Math.round(Math.min(w * 0.64, 740))) : 0;

  // seats cached per address: a new block refreshes "read N ago" text, it never re-seats the world
  const cache = useRef(new Map<string, { sig: string; seat: SphereSeat; ref: WellShip }>());
  const layout = useRef<{ seats: SphereSeat[]; refs: WellShip[] } | null>(null);
  const world = useMemo(() => {
    const prev = cache.current;
    const next = new Map<string, { sig: string; seat: SphereSeat; ref: WellShip }>();
    let changed = layout.current === null || ships.length !== prev.size;
    for (const s of ships) {
      const sig = `${s.primary}|${s.tags.join(',')}|${s.hullTemp}|${s.band}|${s.focused ? 1 : 0}`;
      const p = prev.get(s.address);
      if (p && p.sig === sig) {
        p.ref = s; // fresh meta / flash for the tooltip, same seat
        next.set(s.address, p);
      } else {
        changed = true;
        next.set(s.address, { sig, seat: seatSphere(s), ref: s });
      }
    }
    cache.current = next;
    if (!changed && layout.current) {
      layout.current.refs = [...next.values()].map((v) => v.ref);
      return layout.current;
    }
    const vals = [...next.values()];
    layout.current = { seats: vals.map((v) => v.seat), refs: vals.map((v) => v.ref) };
    return layout.current;
  }, [ships]);
  const refsRef = useRef(world.refs);
  refsRef.current = world.refs;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const foundIdx = useMemo(() => (found ? world.seats.findIndex((s) => s.address === found) : -1), [world, found]);

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
            onHud: (text, lod) => setHud({ text, lod }),
            onHover: (i, x, y) => setHover(i === null ? null : { i, x, y }),
            onOpen: (i) => {
              const r = refsRef.current[i];
              if (r) onOpenRef.current(r.href);
            },
            ...(showFps ? { onFps: (f: number, calls: number) => setFps({ fps: f, calls }) } : {}),
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
    engine.current?.setSeats(world.seats);
    setHover(null);
    setFramed(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, world.seats]);

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
  }, [ready, resetKey, foundIdx]);

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
    world.refs.forEach((r, i) => {
      if (r.flashAt && now - r.flashAt < FLASH_WINDOW_MS) idx.push(i);
    });
    engine.current?.flash(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, flashKey]);

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const eng = engine.current;
    if (!eng) return;
    const k = e.key;
    if (k === 'ArrowLeft') eng.orbitBy(-12);
    else if (k === 'ArrowRight') eng.orbitBy(12);
    else if (k === '+' || k === '=') eng.zoomBy(1.4);
    else if (k === '-' || k === '_') eng.zoomBy(1 / 1.4);
    else if (k === '0' || k === 'Escape') eng.goHome();
    else if (k === 'f' || k === 'F') eng.frameHovered();
    else return;
    e.preventDefault();
  };

  const tipShip = hover ? world.refs[hover.i] : undefined;
  const plateShip = framed ? world.refs[framed.i] : undefined;
  const sizeKey = (
    <div className="wg-key" aria-label="Size key: glyph size is the size band">
      <div className="wg-key-h">SIZE BAND</div>
      {SIZE_KEY.map(([b, t]) => (
        <div key={b} className="wg-key-row">
          <i style={{ width: SPHERE_BAND_W[b] * 640, height: SPHERE_BAND_W[b] * 640 }} />
          <span>{t}</span>
        </div>
      ))}
      <div className="wg-key-row">
        <i className="ring" />
        <span>WOUNDED</span>
      </div>
    </div>
  );

  return (
    <div className="stack" style={{ gap: 10 }} ref={wrap}>
      {failed ? (
        <div className="banner" data-testid="sphere-failed">HULL SPHERE could not start ({failed}). Showing the 2D well instead — pick 2D above.</div>
      ) : null}
      <div
        ref={host}
        className={`wg hs${phone ? ' phone' : ''}`}
        style={{ height: h || undefined }}
        tabIndex={0}
        role="application"
        aria-label={`Hull sphere. ${ships.length} ships. Drag to orbit, plus and minus to zoom, 0 to reset, F to frame.`}
        onKeyDown={onKey}
        data-testid="hull-sphere"
      >
        {!ready && !failed ? <div className="hs-loading">LOADING HULL SPHERE…</div> : null}
        <div className="wg-hud tl">
          <span className="hs-title">HULL SPHERE</span>
          {'\n'}LOD  {hud.lod}
          {fps ? `\nFPS  ${fps.fps}  ·  DRAW CALLS ${fps.calls}  ·  ${ships.length.toLocaleString('en-US')} SHIPS` : ''}
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
            <div className="dim">size band {tipShip.band} · hull {tipShip.hullTemp}</div>
            {tipShip.meta ? <div className="faint">{tipShip.meta}</div> : null}
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
            <div className="dim">hull {plateShip.hullTemp} · band {plateShip.band}</div>
            <button type="button" className="sq-btn" style={{ marginTop: 8 }} onClick={() => onOpen(plateShip.href)}>
              OPEN HULL →
            </button>
          </div>
        ) : null}
      </div>
      {phone ? (
        <div className="wg-strip">
          <span data-testid="sphere-hud">{hud.text}</span>
          <span>LOD {hud.lod}</span>
          {sizeKey}
        </div>
      ) : null}
      <div className="legend wg-legend" aria-hidden>
        <span>LUNE = MAIN POSE</span>
        <span>DEPTH = RISK · NOMINAL / WARN / LIQ ZONE</span>
        <span>SIZE = BAND</span>
        <span className="red">RED RING = WOUNDED</span>
        <span className="faint">THREADS = SAME POSE, NEARBY · DECORATION ONLY</span>
        <span className="faint">DRAG ORBIT · WHEEL / PINCH ZOOM · RIGHT-DRAG PAN · F FRAME · 0 RESET</span>
      </div>
      <ShipList ships={ships} onOpen={onOpen} />
    </div>
  );
}
