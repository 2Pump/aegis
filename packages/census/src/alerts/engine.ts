/**
 * ALERTS — transition engine (pure). Given what a chat watches, what the engine remembered last run and a fresh
 * observation, decide which alerts fire. Alerts fire on CHANGES (transitions), never on every run.
 *
 *  level        SAFE → WATCH → NEAR → LIQ, immediately on the way up; on the way down only after the lower level is
 *               seen RECOVERY_CONFIRM_RUNS runs in a row (hysteresis: no flapping on a wallet sitting on a line)
 *  HF / buffer  the user's own threshold; fires once on crossing below, re-arms only after climbing HYSTERESIS above
 *  class        the wallet's primary classification changed
 *  unreadable   a venue couldn't be read UNREADABLE_CONFIRM_RUNS runs in a row (and again when it's readable)
 *  stale        the chain data read is older than STALE_MIN (said once, never presented as current)
 *  partial      Nado isolated subaccounts may be missing from the reading
 *  scenario     the user's "what if X moves Y%" would liquidate the wallet (and when it no longer would)
 */
import { ALERTS, LEVEL_RANK, scenarioKey, type AlertEvent, type AlertsConfig, type Chat, type Observation, type Watch, type WatchState } from './model.js';

export function evaluate(watch: Watch, prev: WatchState, obs: Observation, now: number, cfg: AlertsConfig = ALERTS): { events: AlertEvent[]; next: WatchState } {
  const ev: AlertEvent[] = [];
  const a = obs.address;
  const next: WatchState = {
    ...prev,
    unreadableRuns: { ...prev.unreadableRuns },
    unreadableSent: { ...prev.unreadableSent },
    lastSent: { ...prev.lastSent },
    lastBlock: obs.block,
    lastCheckedAt: now,
  };
  const wantT = watch.venue !== 'nado';
  const wantN = watch.venue !== 'tydro';

  /* ── readability (per venue) ── */
  for (const v of ['tydro', 'nado'] as const) {
    if ((v === 'tydro' && !wantT) || (v === 'nado' && !wantN)) continue;
    if (!obs[v].readable) {
      next.unreadableRuns[v] = prev.unreadableRuns[v] + 1;
      if (next.unreadableRuns[v] >= cfg.UNREADABLE_CONFIRM_RUNS && !prev.unreadableSent[v]) {
        ev.push({ kind: 'UNREADABLE', address: a, detail: v, venue: v, urgent: false });
        next.unreadableSent[v] = true;
      }
    } else {
      if (prev.unreadableSent[v]) ev.push({ kind: 'READABLE_AGAIN', address: a, detail: v, venue: v, urgent: false });
      next.unreadableRuns[v] = 0;
      next.unreadableSent[v] = false;
    }
  }

  /* ── risk level ── */
  if (obs.level !== 'UNKNOWN') {
    const was = prev.level;
    if (was === null || was === 'UNKNOWN') {
      // first reading: a baseline, not news — unless it is already near or past the line
      if (LEVEL_RANK[obs.level] >= LEVEL_RANK.NEAR) ev.push({ kind: 'LEVEL_UP', address: a, detail: obs.level, from: null, to: obs.level, urgent: true });
      next.level = obs.level;
      next.pendingDown = null;
    } else if (LEVEL_RANK[obs.level] > LEVEL_RANK[was]) {
      ev.push({ kind: 'LEVEL_UP', address: a, detail: obs.level, from: was, to: obs.level, urgent: LEVEL_RANK[obs.level] >= LEVEL_RANK.NEAR });
      next.level = obs.level;
      next.pendingDown = null;
    } else if (LEVEL_RANK[obs.level] < LEVEL_RANK[was]) {
      // hysteresis: the least-recovered level seen while pending is what gets announced
      const p = prev.pendingDown;
      const lvl = p && LEVEL_RANK[p.level] > LEVEL_RANK[obs.level] ? p.level : obs.level;
      const runs = (p ? p.runs : 0) + 1;
      if (runs >= cfg.RECOVERY_CONFIRM_RUNS) {
        ev.push({ kind: 'RECOVERED', address: a, detail: `${was}>${lvl}`, from: was, to: lvl, urgent: false });
        next.level = lvl;
        next.pendingDown = null;
      } else next.pendingDown = { level: lvl, runs };
    } else next.pendingDown = null;

    /* ── classification ── */
    if (was !== null && was !== 'UNKNOWN' && prev.primary !== obs.primary) {
      ev.push({ kind: 'CLASS_CHANGE', address: a, detail: `${prev.primary ?? '-'}>${obs.primary ?? '-'}`, fromTag: prev.primary, toTag: obs.primary, urgent: false });
    }
    next.primary = obs.primary;
  }

  /* ── user thresholds (with hysteresis) ── */
  if (watch.hfBelow !== null && wantT && obs.tydro.readable) {
    const hf = obs.tydro.hf;
    if (prev.hfArmed && hf !== null && hf < watch.hfBelow) {
      ev.push({ kind: 'HF_BELOW', address: a, detail: String(watch.hfBelow), venue: 'tydro', threshold: watch.hfBelow, urgent: hf < 1.05 });
      next.hfArmed = false;
    } else if (!prev.hfArmed && (hf === null || hf >= watch.hfBelow + cfg.HF_HYSTERESIS)) {
      ev.push({ kind: 'HF_RECOVERED', address: a, detail: String(watch.hfBelow), venue: 'tydro', threshold: watch.hfBelow, urgent: false });
      next.hfArmed = true;
    }
  }
  if (watch.bufferBelow !== null && wantN && obs.nado.readable) {
    const b = obs.nado.worstBuffer;
    if (prev.bufferArmed && b !== null && b < watch.bufferBelow) {
      ev.push({ kind: 'BUFFER_BELOW', address: a, detail: String(watch.bufferBelow), venue: 'nado', threshold: watch.bufferBelow, urgent: b < 0.05 });
      next.bufferArmed = false;
    } else if (!prev.bufferArmed && (b === null || b >= watch.bufferBelow + cfg.BUFFER_HYSTERESIS)) {
      ev.push({ kind: 'BUFFER_RECOVERED', address: a, detail: String(watch.bufferBelow), venue: 'nado', threshold: watch.bufferBelow, urgent: false });
      next.bufferArmed = true;
    }
  }

  /* ── data quality ── */
  const stale = obs.dataAt !== null && now - obs.dataAt > cfg.STALE_MIN * 60_000;
  if (stale && !prev.staleSent) ev.push({ kind: 'STALE', address: a, detail: 'stale', urgent: false });
  next.staleSent = stale;
  const partial = wantN && obs.nado.readable && obs.nado.active && obs.nado.partial;
  if (partial && !prev.partialSent) ev.push({ kind: 'PARTIAL', address: a, detail: 'partial', venue: 'nado', urgent: false });
  next.partialSent = partial;

  /* ── scenario ── */
  if (watch.scenario) {
    const hit = obs.scenarios[scenarioKey(watch.scenario)] ?? null;
    if (hit === true && prev.scenarioHit !== true) ev.push({ kind: 'SCENARIO_LIQ', address: a, detail: scenarioKey(watch.scenario), scenario: watch.scenario, urgent: false });
    if (hit === false && prev.scenarioHit === true) ev.push({ kind: 'SCENARIO_CLEAR', address: a, detail: scenarioKey(watch.scenario), scenario: watch.scenario, urgent: false });
    if (hit !== null) next.scenarioHit = hit;
  } else next.scenarioHit = null;

  return { events: ev, next };
}

export const dedupKey = (e: AlertEvent) => `${e.kind}|${e.detail}`;

/**
 * Dedup + cooldown: the same alert (kind + detail) for the same chat and wallet isn't repeated within COOLDOWN_MIN.
 * Urgent alerts (LIQ, first NEAR, HF < 1.05, buffer < 5%) are never held back by the cooldown.
 * Marks what it admits in `state.lastSent` (call `unmark` if delivery then fails).
 */
export function admit(events: readonly AlertEvent[], state: WatchState, now: number, cfg: AlertsConfig = ALERTS): { send: AlertEvent[]; cooled: AlertEvent[] } {
  const send: AlertEvent[] = [];
  const cooled: AlertEvent[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    const k = dedupKey(e);
    if (seen.has(k)) continue; // exact duplicate within one run
    seen.add(k);
    const last = state.lastSent[k];
    if (!e.urgent && last !== undefined && now - last < cfg.COOLDOWN_MIN * 60_000) cooled.push(e);
    else {
      send.push(e);
      state.lastSent[k] = now;
    }
  }
  return { send, cooled };
}

/**
 * Per-chat rate limit: MAX_MSGS_PER_CHAT_PER_HOUR in a rolling hour. An urgent message is always let through
 * (it still counts). A non-urgent one beyond the limit is HELD — counted, audited and mentioned in the next message.
 */
export function rateAllow(chat: Chat, now: number, urgent: boolean, cfg: AlertsConfig = ALERTS): boolean {
  chat.sentAt = chat.sentAt.filter((t) => now - t < 3_600_000);
  return urgent || chat.sentAt.length < cfg.MAX_MSGS_PER_CHAT_PER_HOUR;
}
