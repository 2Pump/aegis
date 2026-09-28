import { useEffect, useMemo, useRef, useState } from 'react';
import { drawWell, hitTest, placeShips, wellView, type PlacedShip, type Ship } from '@aegis/glyphs';
import { TAG_COLORS } from '@aegis/pose';
import { TagChip } from './bits';

export interface WellShip extends Ship {
  href: string;
}

export function Well({ ships, onOpen }: { ships: WellShip[]; onOpen: (href: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const placed = useMemo(() => placeShips(ships), [ships]);
  const [hover, setHover] = useState<{ s: PlacedShip; x: number; y: number } | null>(null);
  const hoverRef = useRef<PlacedShip | null>(null);
  hoverRef.current = hover?.s ?? null;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const frame = (t: number) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawWell(ctx, w, h, placed, reduce ? 0 : t, hoverRef.current);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [placed]);

  const pick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget;
    const rect = c.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const s = hitTest(placed, wellView(rect.width, rect.height), x, y);
    return s ? { s, x, y } : null;
  };

  return (
    <div className="stack">
      <div className="well-wrap" ref={wrap}>
        <canvas
          ref={ref}
          data-testid="well-canvas"
          aria-hidden
          onPointerMove={(e) => setHover(pick(e))}
          onPointerLeave={() => setHover(null)}
          onClick={(e) => {
            const h = pick(e);
            if (h) onOpen((h.s as PlacedShip & WellShip).href);
          }}
        />
        {hover ? (
          <div className="well-tip" style={{ left: hover.x, top: hover.y }}>
            <div className="row" style={{ gap: 6 }}>
              <TagChip tag={hover.s.pose.primary} />
            </div>
            <div style={{ marginTop: 6 }}>{hover.s.label ?? `${hover.s.address.slice(0, 6)}…${hover.s.address.slice(-4)}`}</div>
            <div className="dim">size band {hover.s.band} · hull {hover.s.pose.hullTemp}</div>
            {hover.s.fixture ? <div className="faint">FIXTURE — synthetic</div> : null}
          </div>
        ) : null}
      </div>
      <div className="legend" aria-hidden>
        {(['CARRY', 'NAKED', 'EQUITY-MARGIN', 'KBTC-CORE', 'LOCKED', 'WOUNDED', 'DARK'] as const).map((t) => (
          <span key={t}>
            <i style={{ background: t === 'DARK' ? 'transparent' : TAG_COLORS[t], border: t === 'DARK' ? '1px solid #9CA3AF' : undefined }} />
            {t}
          </span>
        ))}
        <span className="faint">· inner ring = closer to liquidation</span>
      </div>
      {/* Screen-reader / no-canvas fallback */}
      <div className="table-wrap">
        <table className="t" data-testid="ship-list">
          <caption className="sr-only">Ships in the well</caption>
          <thead>
            <tr>
              <th>Hull</th>
              <th>Tags</th>
              <th>Temp</th>
              <th>Size band</th>
            </tr>
          </thead>
          <tbody>
            {placed.map((s) => (
              <tr key={s.address}>
                <td className="mono">
                  <a
                    href={(s as PlacedShip & WellShip).href}
                    onClick={(e) => {
                      e.preventDefault();
                      onOpen((s as PlacedShip & WellShip).href);
                    }}
                  >
                    {s.label ?? `${s.address.slice(0, 6)}…${s.address.slice(-4)}`}
                  </a>
                  {s.fixture ? <span className="src">FIXTURE</span> : null}
                </td>
                <td>
                  <div className="tags">
                    {s.pose.tags.length ? s.pose.tags.map((t) => <TagChip key={t} tag={t} />) : <TagChip tag={null} />}
                  </div>
                </td>
                <td className="mono">{s.pose.hullTemp}</td>
                <td className="mono">{s.band}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
