import type { PriceSource } from '@aegis/pose';

export function fmtUsd(n: number | null | undefined, digits?: number): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const d = digits ?? (abs >= 1000 ? 0 : 2);
  return `${n < 0 ? '−' : ''}$${abs.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

export function fmtAmt(n: number): string {
  const abs = Math.abs(n);
  const d = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return `${n < 0 ? '−' : ''}${abs.toLocaleString('en-US', { maximumFractionDigits: d })}`;
}

export function fmtPct(f: number | null | undefined, digits = 1): string {
  if (f === null || f === undefined || !Number.isFinite(f)) return '—';
  return `${(f * 100).toFixed(digits)}%`;
}

export function fmtAge(ms: number | null, now: number): string {
  if (ms === null) return '—';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h`;
}

export const SRC_LABEL: Record<PriceSource, string> = {
  TYDRO_ORACLE: 'TYDRO PRICE',
  NADO_ORACLE: 'NADO PRICE',
  NADO_ONCHAIN: 'NADO ON-CHAIN',
  FIXTURE: 'TEST PRICE',
  OFFCHAIN_DISPLAY_ONLY: 'DISPLAY ONLY — NOT THE VENUE PRICE',
};
