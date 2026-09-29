import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CAMERA_HOME,
  FLASH_MS,
  GLASS_BAND_R,
  buildGlassGrid,
  buildHaze,
  clampCamera,
  drawGlass,
  drawGlassFrame,
  drawGlassOverlay,
  drawGlassSnapshot,
  frameShip,
  glassGeom,
  glassHeight,
  hitGlass,
  hudText,
  lodText,
  panBy,
  polarOf,
  seatShip,
  toUnit,
  zoomAt,
  type GlassCamera,
  type GlassShip,
  type ShipLite,
} from '@aegis/glyphs';
import { TagChip } from './bits';

export interface WellShip extends ShipLite {
  href: string;
  /** freshness line for the tooltip, e.g. "read 12 s ago (live)" */
  meta?: string;
  /** which venues this book is on (census ships); unknown for hulls opened this session */
  venues?: { tydro: boolean; nado: boolean };
}

type Seat = GlassShip & WellShip;

const BAND_ORDER = ['100k+', '10–100k', '1–10k', '<1k', 'dust'];
const SIZE_KEY: Array<[keyof typeof GLASS_BAND_R, string]> = [
  ['100k+', '$100K+'],
  ['10–100k', '$10–100K'],
  ['1–10k', '$1–10K'],
  ['<1k', '<$1K'],
];

const makeCanvas = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

/**
 * WELL GLASS — polar plot. Bearing = main-pose sector, radius = risk, dot = size band, red ring = WOUNDED.
 * Wheel / pinch zoom, drag to pan, double-click to close in, + − 0 on the keyboard.
 * Nothing on the glass carries a balance, a health number or a liquidation price.
 */
export function Well({
  ships,
  onOpen,
  found = null,
  resetKey = '',
}: {
  ships: WellShip[];
  onOpen: (href: string) => void;
  found?: string | null;
  /** changes when the filter changes: the camera goes home and the glass fades in */
  resetKey?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const frameC = useRef<HTMLCanvasElement>(null);
  const glassC = useRef<HTMLCanvasElement>(null);
  const overC = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, dpr: 1 });
  const [fontsReady, setFontsReady] = useState(0);
  const [cam, setCam] = useState<GlassCamera>(CAMERA_HOME);
  const camRef = useRef(cam);
  camRef.current = cam;
  const [hover, setHover] = useState<{ s: Seat; x: number; y: number } | null>(null);
  const [pointer, setPointer] = useState<{ deg: number; r: number } | null>(null);

  const w = box.w;
  const h = w ? glassHeight(w) : 0;
  const geom = useMemo(() => glassGeom(w || 1, h || 1), [w, h]);
  const geomRef = useRef(geom);
  geomRef.current = geom;

  // Seats are cached per address. Home hands us a fresh array every block (the "read N blocks ago" text changes),
  // but the layout only changes when a pose / tags / hull temp / band changes or the filter adds or removes ships.
  // Re-seating 20k ships and rebuilding the haze once a second would cost phones their frame budget.
  const seatCache = useRef(new Map<string, { sig: string; seat: Seat }>());
  const layout = useRef<Seat[] | null>(null);
  const seats = useMemo(() => {
    const prevCache = seatCache.current;
    const next = new Map<string, { sig: string; seat: Seat }>();
    let changed = layout.current === null || ships.length !== prevCache.size;
    for (const s of ships) {
      const sig = `${s.primary}|${s.tags.join(',')}|${s.hullTemp}|${s.band}|${s.focused ? 1 : 0}`;
      const prev = prevCache.get(s.address);
      if (prev && prev.sig === sig) {
        Object.assign(prev.seat, { meta: s.meta, href: s.href, venues: s.venues, label: s.label, flashAt: s.flashAt });
        next.set(s.address, prev);
      } else {
        changed = true;
        next.set(s.address, { sig, seat: seatShip(s) as Seat });
      }
    }
    seatCache.current = next;
    if (!changed && layout.current) return layout.current;
    layout.current = [...next.values()].map((v) => v.seat).sort((a, b) => a.bandIdx - b.bandIdx);
    return layout.current;
  }, [ships]);
  // live changes: one pulse each — tracked separately so a pulse never forces a re-layout
  const flashKey = useMemo(() => {
    let m = 0;
    for (const s of ships) if (s.flashAt && s.flashAt > m) m = s.flashAt;
    return m;
  }, [ships]);
  const grid = useMemo(() => buildGlassGrid(seats), [seats]);
  const haze = useMemo(() => (w ? buildHaze(seats, geom, makeCanvas) : null), [seats, geom, w]);
  const foundSeat = useMemo(() => (found ? seats.find((s) => s.address === found) ?? null : null), [seats, found]);
  const pinned = useMemo(() => new Set(found ? [found] : []), [found]);

  // size
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setBox({ w: Math.round(el.clientWidth), dpr: Math.min(window.devicePixelRatio || 1, 2) });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    document.fonts?.ready.then(() => setFontsReady((n) => n + 1)).catch(() => {});
  }, []);

  // camera: home on filter change; Find frames the hull
  const foundExists = foundSeat !== null;
  useEffect(() => {
    const s = foundSeat;
    setCam(s ? frameShip(s) : CAMERA_HOME);
    setHover(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, found, foundExists]);

  // 120–200 ms fade when the filter changes — the only motion on the glass besides one pulse per live change
  const [fade, setFade] = useState(0);
  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    setFade((n) => n + 1);
  }, [resetKey]);

  const sizeCanvas = (c: HTMLCanvasElement | null) => {
    if (!c) return null;
    const pw = Math.round(w * box.dpr);
    const ph = Math.round(h * box.dpr);
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    const ctx = c.getContext('2d');
    ctx?.setTransform(box.dpr, 0, 0, box.dpr, 0, 0);
    return ctx;
  };

  // frame: bezel, ticks, sector names — only on resize / font load
  useEffect(() => {
    if (!w) return;
    const ctx = sizeCanvas(frameC.current);
    if (ctx) drawGlassFrame(ctx, geom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geom, box.dpr, fontsReady]);

  // gesture frames: while a wheel / pinch / drag is in flight, move the last sharp render with the camera
  // (one drawImage); the sharp redraw lands ~140 ms after the gesture stops. Keys and buttons draw sharp at once.
  const gesture = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [settled, setSettled] = useState(0);
  const snap = useRef<{ canvas: HTMLCanvasElement; cam: GlassCamera; w: number; dpr: number } | null>(null);
  const gestureTick = () => {
    gesture.current = true;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      gesture.current = false;
      setSettled((n) => n + 1);
    }, 140);
  };
  useEffect(() => () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);

  // glass: once per animation frame at most
  useEffect(() => {
    if (!w) return;
    const raf = requestAnimationFrame(() => {
      const el = glassC.current;
      const ctx = sizeCanvas(el);
      if (!ctx || !el) return;
      const sn = snap.current;
      if (gesture.current && sn && sn.w === w && sn.dpr === box.dpr) {
        drawGlassSnapshot(ctx, geom, sn.canvas, sn.cam, cam);
        return;
      }
      drawGlass(ctx, geom, cam, seats, haze, { pinned, make: makeCanvas, dpr: box.dpr });
      const sc = sn && sn.canvas.width === el.width && sn.canvas.height === el.height ? sn.canvas : makeCanvas(el.width, el.height);
      const sx = sc.getContext('2d');
      if (sx) {
        sx.setTransform(1, 0, 0, 1, 0, 0);
        sx.clearRect(0, 0, sc.width, sc.height);
        sx.drawImage(el, 0, 0);
        snap.current = { canvas: sc, cam, w, dpr: box.dpr };
      }
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geom, box.dpr, cam, seats, haze, pinned, fontsReady, settled]);

  // overlay: hover, found, one pulse per live change (runs frames only while a pulse is live — no idle loop)
  useEffect(() => {
    if (!w) return;
    const ctx = sizeCanvas(overC.current);
    if (!ctx) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const t0 = Date.now();
    const flashes = seats.filter((s) => s.flashAt !== undefined && t0 - s.flashAt < FLASH_MS);
    let raf = 0;
    const frame = () => {
      const running = drawGlassOverlay(ctx, geom, cam, { hover: hover?.s ?? null, found: foundSeat, flashes, now: Date.now(), reduceMotion: reduce });
      if (running) raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geom, box.dpr, cam, seats, hover, foundSeat, flashKey]);

  /* ───── input ───── */
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ moved: boolean; lastDist: number; lastMid: [number, number] | null }>({ moved: false, lastDist: 0, lastMid: null });

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = overC.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const readPointer = (x: number, y: number) => {
    const [ux, uy] = toUnit(geomRef.current, camRef.current, x, y);
    const p = polarOf(ux, uy);
    setPointer(p.r <= 1 ? p : null);
  };
  const pick = (x: number, y: number) => hitGlass(grid, geomRef.current, camRef.current, x, y, foundSeat) as Seat | null;

  // wheel must be non-passive to keep the page still while zooming
  useEffect(() => {
    const el = overC.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const g = geomRef.current;
      const c = camRef.current;
      const [x, y] = local(e);
      if (Math.hypot(x - g.cx, y - g.cy) > g.R) return; // bezel and corners scroll the page
      if (c.zoom <= 1 && e.deltaY > 0) return; // already home: let the page scroll on
      e.preventDefault();
      const unitDelta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      gestureTick();
      setCam(zoomAt(g, c, x, y, Math.exp(-unitDelta * 0.0018)));
      setHover(null);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [w]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [x, y] = local(e);
    pts.current.set(e.pointerId, { x, y });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { moved: false, lastDist: 0, lastMid: null };
    if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()];
      drag.current.lastDist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      drag.current.lastMid = [(a!.x + b!.x) / 2, (a!.y + b!.y) / 2];
    }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [x, y] = local(e);
    readPointer(x, y);
    const prev = pts.current.get(e.pointerId);
    if (!prev) {
      if (e.pointerType === 'mouse') {
        const s = pick(x, y);
        setHover(s ? { s, x, y } : null);
      }
      return;
    }
    pts.current.set(e.pointerId, { x, y });
    const g = geomRef.current;
    if (pts.current.size >= 2) {
      const [a, b] = [...pts.current.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const mid: [number, number] = [(a!.x + b!.x) / 2, (a!.y + b!.y) / 2];
      let c = camRef.current;
      if (drag.current.lastDist > 0) c = zoomAt(g, c, mid[0], mid[1], dist / drag.current.lastDist);
      if (drag.current.lastMid) c = panBy(g, c, mid[0] - drag.current.lastMid[0], mid[1] - drag.current.lastMid[1]);
      drag.current = { moved: true, lastDist: dist, lastMid: mid };
      gestureTick();
      setCam(c);
      setHover(null);
      return;
    }
    const dx = x - prev.x;
    const dy = y - prev.y;
    if (!drag.current.moved && Math.hypot(dx, dy) < 3) {
      pts.current.set(e.pointerId, prev); // below the drag threshold: keep the anchor
      return;
    }
    drag.current.moved = true;
    if (camRef.current.zoom > 1) {
      gestureTick();
      setCam(panBy(g, camRef.current, dx, dy));
      setHover(null);
    }
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const had = pts.current.has(e.pointerId);
    pts.current.delete(e.pointerId);
    if (pts.current.size > 0) {
      drag.current.lastDist = 0;
      drag.current.lastMid = null;
      return;
    }
    if (!had || drag.current.moved) return;
    const [x, y] = local(e);
    const s = pick(x, y);
    if (!s) return;
    if (e.pointerType !== 'mouse' && hover?.s.address !== s.address) {
      setHover({ s, x, y }); // first tap on a touch screen shows the plate; the second opens it
      return;
    }
    onOpen(s.href);
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const [x, y] = local(e);
    const g = geomRef.current;
    if (Math.hypot(x - g.cx, y - g.cy) > g.R) return;
    setCam(zoomAt(g, camRef.current, x, y, 2.2));
  };
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const g = geomRef.current;
    const c = camRef.current;
    const step = 40;
    const k = e.key;
    let next: GlassCamera | null = null;
    if (k === '+' || k === '=') next = zoomAt(g, c, g.cx, g.cy, 1.4);
    else if (k === '-' || k === '_') next = zoomAt(g, c, g.cx, g.cy, 1 / 1.4);
    else if (k === '0' || k === 'Escape') next = CAMERA_HOME;
    else if (k === 'ArrowLeft') next = panBy(g, c, step, 0);
    else if (k === 'ArrowRight') next = panBy(g, c, -step, 0);
    else if (k === 'ArrowUp') next = panBy(g, c, 0, step);
    else if (k === 'ArrowDown') next = panBy(g, c, 0, -step);
    if (!next) return;
    e.preventDefault();
    setCam(clampCamera(next));
    setHover(null);
  };
  const zoomBtn = (f: number | 'home') => {
    const g = geomRef.current;
    setCam(f === 'home' ? CAMERA_HOME : zoomAt(g, camRef.current, g.cx, g.cy, f));
    setHover(null);
  };

  const hudPoint = pointer ?? (cam.zoom > 1 ? polarOf(cam.fx, cam.fy) : null);
  const hud = hudText(hudPoint, cam.zoom);
  const lod = lodText(cam.zoom, geom.phone);
  const zoomed = cam.zoom > 1.001;

  const sizeKey = (
    <div className="wg-key" aria-label="Size key: dot size is the size band">
      <div className="wg-key-h">SIZE BAND</div>
      {SIZE_KEY.map(([b, t]) => (
        <div key={b} className="wg-key-row">
          <i style={{ width: GLASS_BAND_R[b] * 2 * geom.k, height: GLASS_BAND_R[b] * 2 * geom.k }} />
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
    <div className="stack" style={{ gap: 10 }}>
      <div
        ref={wrap}
        className={`wg${geom.phone ? ' phone' : ''}`}
        style={{ height: h || undefined }}
        tabIndex={0}
        role="application"
        aria-label={`Well glass. ${ships.length} ships. Plus and minus to zoom, 0 to reset, arrows to pan.`}
        onKeyDown={onKey}
        data-testid="well-glass"
      >
        <canvas ref={frameC} className="wg-layer" aria-hidden style={{ height: h }} />
        <canvas key={fade} ref={glassC} className={`wg-layer${fade ? ' wg-fade' : ''}`} data-testid="well-canvas" aria-hidden style={{ height: h }} />
        <canvas
          ref={overC}
          className="wg-layer wg-input"
          aria-hidden
          style={{ height: h, touchAction: zoomed ? 'none' : 'pan-y', cursor: zoomed ? 'grab' : 'default' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={(e) => {
            pts.current.delete(e.pointerId);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse') {
              setHover(null);
              setPointer(null);
            }
          }}
          onDoubleClick={onDoubleClick}
        />
        {!geom.phone ? (
          <>
            <div className="wg-hud tl">{lod}</div>
            <div className="wg-hud tr">{sizeKey}</div>
            <div className="wg-hud bl" data-testid="well-hud">{hud}</div>
          </>
        ) : null}
        <div className="wg-hud br wg-zoom" role="group" aria-label="Zoom">
          <button type="button" onClick={() => zoomBtn(1.6)} aria-label="Zoom in">+</button>
          <button type="button" onClick={() => zoomBtn(1 / 1.6)} aria-label="Zoom out" disabled={!zoomed}>−</button>
          <button type="button" onClick={() => zoomBtn('home')} aria-label="Reset zoom" disabled={!zoomed}>0</button>
        </div>
        {hover ? (
          <div className="well-tip" style={{ left: Math.max(4, Math.min(hover.x, w - 210)), top: Math.min(hover.y, h - 90) }}>
            <div className="tags">
              <TagChip tag={hover.s.primary} />
              {hover.s.tags.includes('WOUNDED') && hover.s.primary !== 'WOUNDED' ? <TagChip tag="WOUNDED" /> : null}
            </div>
            <div style={{ marginTop: 6 }}>{hover.s.label ?? `${hover.s.address.slice(0, 6)}…${hover.s.address.slice(-4)}`}</div>
            <div className="dim">size band {hover.s.band} · hull {hover.s.hullTemp}</div>
            {hover.s.meta ? <div className="faint">{hover.s.meta}</div> : null}
            {geom.phone ? <div className="faint">tap again to open</div> : null}
          </div>
        ) : null}
      </div>
      {geom.phone ? (
        <div className="wg-strip">
          <span data-testid="well-hud">{hud}</span>
          <span>{lod}</span>
          {sizeKey}
        </div>
      ) : null}
      <div className="legend wg-legend" aria-hidden>
        <span>BEARING = MAIN POSE</span>
        <span>RADIUS = RISK · NOMINAL / WARN / LIQ ZONE</span>
        <span>DOT = SIZE BAND</span>
        <span className="red">RED RING = WOUNDED</span>
        <span className="faint">WHEEL / PINCH ZOOM · DRAG PAN · + − 0</span>
      </div>
      <ShipList ships={seats} onOpen={onOpen} />
    </div>
  );
}

/** Accessible list: wounded first, then biggest bands; paginated. */
export function ShipList({ ships, onOpen }: { ships: readonly WellShip[]; onOpen: (href: string) => void }) {
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(false);
  const PER = 50;
  // sorted only while the list is open, and only when the layout changes — never per live block
  const listed = useMemo(() => {
    if (!open) return [];
    const rank = (s: WellShip) => (s.tags.includes('WOUNDED') ? 0 : 10) + BAND_ORDER.indexOf(s.band);
    return ships
      .map((s) => [rank(s), s] as const)
      .sort((a, b) => a[0] - b[0])
      .map((x) => x[1]);
  }, [ships, open]);
  const pages = Math.max(1, Math.ceil(ships.length / PER));
  const view = listed.slice(page * PER, page * PER + PER);
  return (
    <details className="ship-list" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="mono dim" style={{ fontSize: 12, cursor: 'pointer' }}>
        List view ({ships.length.toLocaleString('en-US')} ships) — for screen readers and scanning
      </summary>
      <div className="table-wrap" style={{ marginTop: 8 }}>
        <table className="t" data-testid="ship-list">
          <caption className="sr-only">Ships in the well</caption>
          <thead>
            <tr>
              <th>Hull</th>
              <th>Tags</th>
              <th>Temp</th>
              <th>Size band</th>
              <th>Read</th>
            </tr>
          </thead>
          <tbody>
            {view.map((s) => (
              <tr key={s.address}>
                <td className="mono">
                  <a
                    href={s.href}
                    onClick={(e) => {
                      e.preventDefault();
                      onOpen(s.href);
                    }}
                  >
                    {s.label ?? `${s.address.slice(0, 6)}…${s.address.slice(-4)}`}
                  </a>
                </td>
                <td>
                  <div className="tags">{s.tags.length ? s.tags.map((t) => <TagChip key={t} tag={t} />) : <TagChip tag={null} />}</div>
                </td>
                <td className="mono">{s.hullTemp}</td>
                <td className="mono">{s.band}</td>
                <td className="mono faint">{s.meta ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 ? (
        <div className="row" style={{ marginTop: 8 }}>
          <button className="pill-btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Prev</button>
          <span className="mono dim" style={{ fontSize: 12 }}>page {page + 1} / {pages}</span>
          <button className="pill-btn" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      ) : null}
    </details>
  );
}
