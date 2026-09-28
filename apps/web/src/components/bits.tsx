import type { HullTemp, PriceSource, Tag } from '@aegis/pose';
import { tagColor } from '@aegis/glyphs';
import { fmtUsd, SRC_LABEL } from '../lib/fmt';

export function TagChip({ tag, primary = false, filled = false }: { tag: Tag | null; primary?: boolean; filled?: boolean }) {
  const color = tagColor(tag);
  return (
    <span
      className={`tag${primary ? ' primary' : ''}${filled ? ' filled' : ''}`}
      style={{ color, background: filled ? color : 'transparent' }}
      data-testid={primary ? 'primary-tag' : undefined}
    >
      {tag ?? 'NO RULE FIRED'}
    </span>
  );
}

export function Lamp({ state, label }: { state: 'ok' | 'dark' | 'warn' | 'bad'; label: string }) {
  return (
    <span className={`lamp ${state}`}>
      <i aria-hidden />
      {label}
    </span>
  );
}

export function Usd({ n, src }: { n: number | null | undefined; src?: PriceSource }) {
  return (
    <span className="num">
      {fmtUsd(n)}
      {src ? <span className="src">{SRC_LABEL[src]}</span> : null}
    </span>
  );
}

export const TEMP_RAIL: Record<HullTemp, string> = {
  NOMINAL: 'var(--cyan)',
  ELEVATED: 'var(--amber)',
  CRITICAL: 'var(--red)',
  UNKNOWN: 'var(--slate)',
};

export function Panel({ idx, title, rail, right, children, testId }: { idx?: string; title: string; rail?: string; right?: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <section className="panel" style={{ ['--rail' as string]: rail ?? 'var(--slate)' }} data-testid={testId}>
      <div className="rail" aria-hidden />
      <div className="body">
        <h3 className="panel-title">
          {idx ? <span className="idx">{idx}</span> : null}
          {title}
          {right ? <span className="right">{right}</span> : null}
        </h3>
        {children}
      </div>
    </section>
  );
}
