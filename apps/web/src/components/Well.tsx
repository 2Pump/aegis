import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildGrid,
  drawWellOverlay,
  drawWellStatic,
  hitTest,
  placeShips,
  wellView,
  type PlacedShip,
  type ShipGrid,
  type ShipLite,
} from '@aegis/glyphs';
import { TAG_COLORS } from '@aegis/pose';
import { TagChip } from './bits';

export interface WellShip extends ShipLite {
  href: string;
  /** freshness line for the tooltip, e.g. "read 12 s ago (live)" */
  meta?: string;
  /** which venues this book is on (census ships); unknown for hulls opened this session */
  venues?: { tydro: boolean; nado: boolean };
}

/** Above this many wounded ships in view, only the bigger ones pulse — hundreds of rings read as one red blob. */
const PULSE_ALL_MAX = 250;
const BIG_BANDS = new Set(['1–10k', '10–100k', '100k+']);

const BAND_ORDER = ['100k+', '10–100k', '1–10k', '<1k', 'dust'];

export function Well({ ships, onOpen, found = null }: { ships: WellShip[]; onOpen: (href: string) => void; found?: string | null }) {
  const base = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0, dpr: 1 });
  const placed = useMemo(() => placeShips(ships) as Array<PlacedShip & WellShip>, [ships]);
  const grid = useRef<ShipGrid | null>(null);
  const [hover, setHover] = useState<{ s: PlacedShip & WellShip; x: number; y: number } | null>(null);
  const hoverRef = useRef<PlacedShip | null>(null);
  hoverRef.current = hover?.s ?? null;
  const foundShip = useMemo(() => (found ? placed.find((s) => s.address === found) ?? null : null), [placed, found]);
  const foundRef = useRef<PlacedShip | null>(null);
  foundRef.current = foundShip;

  // track size
  useEffect(() => {
    const c = base.current;
    if (!c) return;
    const ro = new ResizeObserver(() => setSize({ w: c.clientWidth, h: c.clientHeight, dpr: Math.min(window.devicePixelRatio || 1, 2) }));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  // static layer: only when data or size changes
  useEffect(() => {
    const c = base.current;
    const o = over.current;
    if (!c || !o || !size.w) return;
    for (const el of [c, o]) {
      el.width = Math.round(size.w * size.dpr);
      el.height = Math.round(size.h * size.dpr);
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    drawWellStatic(ctx, size.w, size.h, placed);
    grid.current = buildGrid(placed, wellView(size.w, size.h));
  }, [placed, size]);

  // animated layer: pulses, flashes, hover
  useEffect(() => {
    const o = over.current;
    if (!o || !size.w) return;
    const ctx = o.getContext('2d');
    if (!ctx) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let raf = 0;
    const pulseAll = placed.filter((s) => s.pulse).length <= PULSE_ALL_MAX;
    const frame = (t: number) => {
      const now = Date.now();
      const animated = placed
        .filter((s) => s.pulse || (s.flashAt !== undefined && now - s.flashAt < 6000))
        .map((s) => (s.pulse && !pulseAll && !BIG_BANDS.has(s.band) ? { ...s, pulse: false } : s));
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      drawWellOverlay(ctx, size.w, size.h, animated, reduce ? 0 : t, now, hoverRef.current, foundRef.current);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [placed, size]);

  const pick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const s = grid.current ? (hitTest(grid.current, x, y) as (PlacedShip & WellShip) | null) : null;
    return s ? { s, x, y } : null;
  };

  // accessible list: wounded first, then biggest bands; paginated
  const [page, setPage] = useState(0);
  const PER = 50;
  const listed = useMemo(
    () =>
      [...ships].sort(
        (a, b) =>
          Number(b.tags.includes('WOUNDED')) - Number(a.tags.includes('WOUNDED')) || BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band),
      ),
    [ships],
  );
  const pages = Math.max(1, Math.ceil(listed.length / PER));
  const view = listed.slice(page * PER, page * PER + PER);

  return (
    <div className="stack">
      <div className="well-wrap">
        <canvas ref={base} className="well-layer" data-testid="well-canvas" aria-hidden />
        <canvas
          ref={over}
          className="well-layer"
          aria-hidden
          onPointerMove={(e) => setHover(pick(e))}
          onPointerLeave={() => setHover(null)}
          onClick={(e) => {
            const h = pick(e);
            if (h) onOpen(h.s.href);
          }}
        />
        {hover ? (
          <div className="well-tip" style={{ left: Math.min(hover.x, size.w - 200), top: hover.y }}>
            <div className="tags">
              <TagChip tag={hover.s.primary} />
              {hover.s.tags.includes('WOUNDED') && hover.s.primary !== 'WOUNDED' ? <TagChip tag="WOUNDED" /> : null}
            </div>
            <div style={{ marginTop: 6 }}>{hover.s.label ?? `${hover.s.address.slice(0, 6)}…${hover.s.address.slice(-4)}`}</div>
            <div className="dim">size band {hover.s.band} · hull {hover.s.hullTemp}</div>
            {hover.s.meta ? <div className="faint">{hover.s.meta}</div> : null}
          </div>
        ) : null}
      </div>
      <div className="legend" aria-hidden>
        {(['CARRY', 'NAKED', 'EQUITY-MARGIN', 'KBTC-CORE', 'LOCKED', 'STABLE-BALLAST', 'LEVERED', 'HOLD', 'WOUNDED', 'DARK'] as const).map((t) => (
          <span key={t}>
            <i style={{ background: t === 'DARK' ? 'transparent' : TAG_COLORS[t], border: t === 'DARK' ? '1px solid #9CA3AF' : undefined }} />
            {t}
          </span>
        ))}
        <span>
          <i style={{ background: 'transparent', border: '2px solid #FF4D4D' }} />
          red ring = wounded
        </span>
        <span className="faint">· dot color = main pose · inner ring = closer to liquidation · dot size = size band</span>
      </div>
      <details className="ship-list">
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
    </div>
  );
}
