/**
 * ALERTS — message text (pure). Plain text (no Markdown, so nothing in it needs escaping).
 * A message names the wallet, the venue, the risk level, HF / margin buffer, how old the data is, the block, a link
 * to the wallet page, and the versions it was judged under. It NEVER carries balances or position sizes.
 */
import { FOOTER_TEXT } from './text.js';
import { LEVEL_TEXT, type AlertEvent, type Observation, type Watch } from './model.js';

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const pctText = (x: number) => `${(x * 100).toFixed(1)}%`;
const hfText = (x: number) => x.toFixed(2);

export function ageText(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return 'under a minute';
  if (m < 120) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

export function eventLine(e: AlertEvent, obs: Observation): string {
  switch (e.kind) {
    case 'LEVEL_UP':
      return e.from ? `▲ ${LEVEL_TEXT[e.to!]} (was ${LEVEL_TEXT[e.from]})` : `▲ Already ${LEVEL_TEXT[e.to!]} when first read`;
    case 'RECOVERED':
      return `▼ Back to ${LEVEL_TEXT[e.to!]} (was ${LEVEL_TEXT[e.from!]}) — seen on consecutive readings`;
    case 'HF_BELOW':
      return `• Tydro health factor ${obs.tydro.hf !== null ? hfText(obs.tydro.hf) : '—'} — below your ${hfText(e.threshold!)}`;
    case 'HF_RECOVERED':
      return obs.tydro.hf === null ? `• Tydro: no debt now — your HF ${hfText(e.threshold!)} alert is re-armed` : `• Tydro health factor back to ${hfText(obs.tydro.hf)} — above your ${hfText(e.threshold!)} again`;
    case 'BUFFER_BELOW':
      return `• Nado margin buffer ${obs.nado.worstBuffer !== null ? pctText(obs.nado.worstBuffer) : '—'} (worst subaccount) — below your ${pctText(e.threshold!)}`;
    case 'BUFFER_RECOVERED':
      return obs.nado.worstBuffer === null ? `• Nado: nothing at risk now — your buffer ${pctText(e.threshold!)} alert is re-armed` : `• Nado margin buffer back to ${pctText(obs.nado.worstBuffer)} — above your ${pctText(e.threshold!)} again`;
    case 'CLASS_CHANGE':
      return `• Classification changed: ${e.fromTag ?? 'no rule fired'} → ${e.toTag ?? 'no rule fired'}`;
    case 'UNREADABLE':
      return `• ${e.venue === 'tydro' ? 'Tydro' : 'Nado'} couldn't be read on the last readings — AEGIS can't see this side of the wallet right now, so it can't tell you if it gets worse`;
    case 'READABLE_AGAIN':
      return `• ${e.venue === 'tydro' ? 'Tydro' : 'Nado'} can be read again`;
    case 'STALE':
      return `• STALE: the chain data AEGIS could read is ${obs.dataAt !== null ? ageText(obs.readAt - obs.dataAt) : 'of unknown age'} old — treat this as "as of then", not now`;
    case 'PARTIAL':
      return '• PARTIAL: Nado isolated subaccounts may be missing from this reading — the real risk can be higher than shown';
    case 'SCENARIO_LIQ':
      return `• Your scenario: if ${e.scenario!.direction} moved ${e.scenario!.pct > 0 ? '+' : ''}${e.scenario!.pct}%, this wallet would now be liquidatable (modelled, not a prediction)`;
    case 'SCENARIO_CLEAR':
      return `• Your scenario (${e.scenario!.direction} ${e.scenario!.pct > 0 ? '+' : ''}${e.scenario!.pct}%) would no longer liquidate this wallet`;
  }
}

/** The "risk now" line: level, HF and worst Nado buffer — the same figures the wallet page shows, never balances. */
export function riskLine(obs: Observation): string {
  const parts = [`Risk now: ${LEVEL_TEXT[obs.level]}`];
  if (!obs.tydro.readable) parts.push('Tydro unreadable');
  else if (obs.tydro.hf !== null) parts.push(`Tydro HF ${hfText(obs.tydro.hf)}`);
  if (!obs.nado.readable) parts.push('Nado unreadable');
  else if (obs.nado.worstBuffer !== null) parts.push(`Nado buffer ${pctText(obs.nado.worstBuffer)} (worst subaccount)`);
  return parts.join(' · ');
}

export function provenance(obs: Observation, now: number): string[] {
  const out: string[] = [];
  const labels = [obs.approximate ? 'APPROXIMATE' : null, obs.nado.partial && obs.nado.active ? 'PARTIAL (Nado)' : null].filter(Boolean);
  if (labels.length) out.push(`Reading is ${labels.join(' · ')} — see the wallet page for why.`);
  const age = obs.dataAt !== null ? ageText(now - obs.dataAt) : 'unknown age';
  out.push(`Data: block ${obs.block !== null ? obs.block.toLocaleString('en-US') : '—'} · ${age} old`);
  return out;
}

export function formatAlert(events: readonly AlertEvent[], obs: Observation, opts: { now: number; siteUrl: string; held?: number; alertsVersion: string }): string {
  return [
    `AEGIS · ${short(obs.address)}`,
    ...events.map((e) => eventLine(e, obs)),
    '',
    riskLine(obs),
    ...provenance(obs, opts.now),
    `${opts.siteUrl.replace(/\/$/, '')}/hull/${obs.address}`,
    ...(opts.held ? [`(${opts.held} other alert${opts.held === 1 ? '' : 's'} held back by the rate limit — /status shows where everything stands)`] : []),
    `rules ${obs.rulesVersion} · engine ${obs.engineVersion} · alerts ${opts.alertsVersion}`,
    FOOTER_TEXT,
  ].join('\n');
}

export function watchLine(w: Watch): string {
  const opts = [
    w.venue !== 'any' ? `${w.venue} only` : null,
    w.hfBelow !== null ? `HF < ${hfText(w.hfBelow)}` : null,
    w.bufferBelow !== null ? `buffer < ${pctText(w.bufferBelow)}` : null,
    w.scenario ? `scenario ${w.scenario.direction} ${w.scenario.pct > 0 ? '+' : ''}${w.scenario.pct}%` : null,
  ].filter(Boolean);
  return `${w.address}${opts.length ? ` — ${opts.join(', ')}` : ''}`;
}
