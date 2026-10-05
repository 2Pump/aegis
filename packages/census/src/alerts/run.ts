/**
 * ALERTS — one run (pure orchestration; every IO is injected). Called by scripts/alerts.ts on a schedule.
 *   1. read new commands from the transport and answer each one
 *   2. retry messages whose delivery failed last time
 *   3. read every watched wallet ONCE (however many chats watch it), oldest-checked first, capped per run
 *   4. per chat × wallet: evaluate transitions → dedup / cooldown → rate limit → format → deliver → audit
 * Returns the updated db; the caller persists it. A failure in one step is recorded and the run carries on.
 */
import { evaluate, admit, rateAllow, dedupKey } from './engine.js';
import { handleCommand } from './commands.js';
import { formatAlert, short } from './format.js';
import { ALERTS, audit, freshState, stateKey, type AlertsConfig, type AlertsDb, type Observation, type Watch } from './model.js';
import type { AlertsTransport } from './transport.js';
import { FOOTER_TEXT } from './text.js';
import { liquidationEvents } from '../events.js';
import type { LedgerRecord } from '../ledger.js';

export interface RunDeps {
  transport: AlertsTransport;
  /** read one wallet now; may throw or return null (= couldn't read at all) */
  read: (address: string, scenarios: ReadonlyArray<Watch['scenario']>) => Promise<Observation | null>;
  now: () => number;
  fixtures: ReadonlySet<string>;
  siteUrl: string;
  hashChat: (chatId: string) => string;
  cfg?: AlertsConfig;
  log?: (m: string) => void;
  /** Ink-wide events (events.ts: oracle, parameter changes, stress level, cascades, failed checks) — /protocol on */
  protocolEvents?: ReadonlyArray<{ id: string; at: number; text: string; urgent?: boolean }>;
  /** recent ledger records: a watched wallet that is actually liquidated is always told (urgent) */
  liquidations?: readonly LedgerRecord[];
}

export interface RunReport {
  commands: number;
  reads: number;
  unreadable: number;
  sent: number;
  held: number;
  cooled: number;
  failed: number;
  retried: number;
  erasedChats: number;
  notes: string[];
}

/** A reading that couldn't happen at all: both venues unreadable, level unknown — never "safe". */
export function unreadableObservation(address: string, now: number): Observation {
  return {
    address,
    readAt: now,
    dataAt: null,
    block: null,
    tydro: { readable: false, active: false, hf: null },
    nado: { readable: false, active: false, worstBuffer: null, partial: false },
    level: 'UNKNOWN',
    hullTemp: 'UNKNOWN',
    primary: null,
    approximate: true,
    rulesVersion: '—',
    engineVersion: '—',
    scenarios: {},
  };
}

function eraseChat(db: AlertsDb, chatId: string): void {
  for (const k of Object.keys(db.state)) if (k.startsWith(`${chatId}|`)) delete db.state[k];
  delete db.chats[chatId];
  db.outbox = db.outbox.filter((o) => o.chatId !== chatId);
}

export async function runAlerts(dbIn: AlertsDb, deps: RunDeps): Promise<{ db: AlertsDb; report: RunReport }> {
  const cfg = deps.cfg ?? ALERTS;
  const log = deps.log ?? (() => {});
  const db: AlertsDb = { ...dbIn, outbox: dbIn.outbox ?? [], checked: dbIn.checked ?? {} };
  const rep: RunReport = { commands: 0, reads: 0, unreadable: 0, sent: 0, held: 0, cooled: 0, failed: 0, retried: 0, erasedChats: 0, notes: [] };

  const deliver = async (chatId: string, text: string, kind: 'reply' | 'alert'): Promise<boolean> => {
    const r = await deps.transport.send(chatId, text).catch((e: unknown) => ({ ok: false as const, retryable: true, blocked: false, error: String(e) }));
    if (r.ok) return true;
    const h = deps.hashChat(chatId);
    if (r.blocked) {
      // the person blocked the bot or the chat is gone: stop, and erase what was stored for them
      eraseChat(db, chatId);
      rep.erasedChats++;
      audit(db, { at: deps.now(), chat: h, kind: 'chat-blocked', detail: 'chat unreachable (blocked/left) — erased' }, cfg);
      return false;
    }
    rep.failed++;
    audit(db, { at: deps.now(), chat: h, kind: 'delivery-failed', detail: `${kind}: ${r.error.slice(0, 120)}${r.retryable && kind === 'alert' ? ' — will retry' : ''}` }, cfg);
    if (r.retryable && kind === 'alert') db.outbox.push({ chatId, text, attempts: 1, firstAt: deps.now() });
    return false;
  };

  /* 1 ── commands */
  try {
    const { messages, next } = await deps.transport.poll(db.cursor);
    for (const m of messages) {
      const reply = await handleCommand(db, m.chatId, m.text, { now: deps.now(), fixtures: deps.fixtures, siteUrl: deps.siteUrl, hashChat: deps.hashChat, read: deps.read, cfg }).catch((e: unknown) => {
        rep.notes.push(`command failed: ${String(e).slice(0, 120)}`);
        return 'Something went wrong handling that. Nothing was changed by the failed part; try again shortly.';
      });
      if (reply !== null) {
        rep.commands++;
        await deliver(m.chatId, reply, 'reply');
      }
    }
    db.cursor = next;
  } catch (e) {
    rep.notes.push(`couldn't fetch new commands: ${String(e).slice(0, 160)}`);
  }

  /* 2 ── retry earlier failures */
  const retry = db.outbox;
  db.outbox = [];
  for (const o of retry) {
    if (!db.chats[o.chatId]) continue;
    const r = await deps.transport.send(o.chatId, o.text).catch((e: unknown) => ({ ok: false as const, retryable: true, blocked: false, error: String(e) }));
    rep.retried++;
    if (r.ok) {
      rep.sent++;
      db.chats[o.chatId]!.sentAt.push(deps.now());
    } else if (r.blocked) {
      eraseChat(db, o.chatId);
      rep.erasedChats++;
      audit(db, { at: deps.now(), chat: deps.hashChat(o.chatId), kind: 'chat-blocked', detail: 'chat unreachable (blocked/left) — erased' }, cfg);
    } else if (r.retryable && o.attempts + 1 < cfg.MAX_SEND_ATTEMPTS) db.outbox.push({ ...o, attempts: o.attempts + 1 });
    else audit(db, { at: deps.now(), chat: deps.hashChat(o.chatId), kind: 'delivery-failed', detail: `gave up after ${o.attempts + 1} attempts: ${r.error.slice(0, 100)}` }, cfg);
  }

  /* 3 ── read every watched wallet once */
  const watchers = new Map<string, Array<{ chatId: string; w: Watch }>>();
  for (const c of Object.values(db.chats)) {
    if (c.paused) continue;
    for (const w of c.watches) watchers.set(w.address, [...(watchers.get(w.address) ?? []), { chatId: c.id, w }]);
  }
  const order = [...watchers.keys()].sort((a, b) => (db.checked[a] ?? 0) - (db.checked[b] ?? 0));
  const todo = order.slice(0, cfg.MAX_ADDRESSES_PER_RUN);
  if (order.length > todo.length) rep.notes.push(`${order.length - todo.length} wallet(s) wait for the next run (per-run cap ${cfg.MAX_ADDRESSES_PER_RUN})`);
  const obs = new Map<string, Observation>();
  for (let i = 0; i < todo.length; i += cfg.READ_CONCURRENCY) {
    await Promise.all(
      todo.slice(i, i + cfg.READ_CONCURRENCY).map(async (a) => {
        const scen = watchers.get(a)!.map((x) => x.w.scenario).filter(Boolean);
        const o = await deps.read(a, scen).catch(() => null);
        rep.reads++;
        if (!o || (!o.tydro.readable && !o.nado.readable)) rep.unreadable++;
        obs.set(a, o ?? unreadableObservation(a, deps.now()));
        db.checked[a] = deps.now();
      }),
    );
  }

  /* 4 ── evaluate, dedup, rate-limit, deliver */
  for (const a of todo) {
    const o = obs.get(a)!;
    for (const { chatId, w } of watchers.get(a)!) {
      const chat = db.chats[chatId];
      if (!chat) continue; // erased mid-run (blocked)
      const k = stateKey(chatId, a);
      const now = deps.now();
      const { events, next } = evaluate(w, db.state[k] ?? freshState(), o, now, cfg);
      const { send, cooled } = admit(events, next, now, cfg);
      rep.cooled += cooled.length;
      db.state[k] = next;
      if (!send.length) continue;
      const urgent = send.some((e) => e.urgent);
      if (!rateAllow(chat, now, urgent, cfg)) {
        chat.held += send.length;
        rep.held += send.length;
        for (const e of send) delete next.lastSent[dedupKey(e)]; // held, not "sent": the cooldown must not swallow it later
        audit(db, { at: now, chat: deps.hashChat(chatId), kind: 'held', detail: `${short(a)}: ${send.map((e) => e.kind).join(',')} (rate limit)` }, cfg);
        continue;
      }
      const text = formatAlert(send, o, { now, siteUrl: deps.siteUrl, held: chat.held, alertsVersion: cfg.VERSION });
      if (await deliver(chatId, text, 'alert')) {
        rep.sent++;
        chat.sentAt.push(now);
        chat.held = 0;
        audit(db, { at: now, chat: deps.hashChat(chatId), kind: 'alert', detail: `${short(a)}: ${send.map((e) => e.kind).join(',')}` }, cfg);
      }
    }
  }
  /* 5 ── Ink-wide protocol events, to chats that opted in (/protocol on) */
  for (const chat of Object.values(db.chats)) {
    if (chat.paused || !chat.protocol) continue;
    const seen = new Set(chat.seenProtocol ?? []);
    for (const e of deps.protocolEvents ?? []) {
      if (seen.has(e.id) || e.at < (chat.protocolSince ?? Infinity)) continue;
      const now = deps.now();
      seen.add(e.id);
      if (!rateAllow(chat, now, !!e.urgent, cfg)) {
        chat.held += 1;
        rep.held += 1;
        audit(db, { at: now, chat: deps.hashChat(chat.id), kind: 'held', detail: 'protocol event (rate limit)' }, cfg);
        continue;
      }
      const text = [`AEGIS · Ink protocol watch`, e.text, '', `${deps.siteUrl.replace(/\/$/, '')}/intel`, FOOTER_TEXT].join('\n');
      if (await deliver(chat.id, text, 'alert')) {
        rep.sent++;
        chat.sentAt.push(now);
        audit(db, { at: now, chat: deps.hashChat(chat.id), kind: 'alert', detail: `protocol: ${e.id.slice(0, 60)}` }, cfg);
      }
    }
    if (db.chats[chat.id]) db.chats[chat.id]!.seenProtocol = [...seen].slice(-300);
  }

  /* 6 ── actual liquidations of watched wallets (from the ledger; always on — it's the wallet they asked about) */
  if (deps.liquidations?.length) {
    const watchedAll = new Set(Object.values(db.chats).flatMap((c) => c.watches.map((w) => w.address)));
    const liqEv = liquidationEvents(deps.liquidations, watchedAll);
    for (const chat of Object.values(db.chats)) {
      if (chat.paused) continue;
      const seen = new Set(chat.seenLiq ?? []);
      for (const e of liqEv) {
        const w = chat.watches.find((x) => x.address === e.data.wallet);
        if (!w || seen.has(e.id) || e.at < w.createdAt) continue;
        seen.add(e.id);
        const now = deps.now();
        if (!rateAllow(chat, now, true, cfg)) {
          chat.held += 1;
          rep.held += 1;
          continue;
        }
        const text = [`AEGIS · LIQUIDATED`, `${e.text}.`, `It happened on-chain at block ${e.block ?? '—'} — what AEGIS had recorded before it is on the wallet page.`, '', `${deps.siteUrl.replace(/\/$/, '')}/hull/${String(e.data.wallet)}`, FOOTER_TEXT].join('\n');
        if (await deliver(chat.id, text, 'alert')) {
          rep.sent++;
          chat.sentAt.push(now);
          audit(db, { at: now, chat: deps.hashChat(chat.id), kind: 'alert', detail: `liquidated: ${short(String(e.data.wallet))}` }, cfg);
        }
      }
      if (db.chats[chat.id]) db.chats[chat.id]!.seenLiq = [...seen].slice(-300);
    }
  }

  // state for wallets no chat watches any more is dropped (nothing kept that isn't needed)
  for (const k of Object.keys(db.state)) {
    const [c, a] = k.split('|');
    if (!db.chats[c!]?.watches.some((w) => w.address === a)) delete db.state[k];
  }
  for (const a of Object.keys(db.checked)) if (!watchers.has(a)) delete db.checked[a];

  db.lastRun = { at: deps.now(), ok: rep.failed === 0 && rep.notes.every((n) => !/couldn't|failed/.test(n)), reads: rep.reads, sent: rep.sent, held: rep.held, failed: rep.failed, note: rep.notes.join(' · ').slice(0, 300) };
  log(`alerts: ${rep.commands} command(s), ${rep.reads} read(s) (${rep.unreadable} unreadable), ${rep.sent} sent, ${rep.held} held, ${rep.cooled} cooled, ${rep.failed} failed`);
  return { db, report: rep };
}
