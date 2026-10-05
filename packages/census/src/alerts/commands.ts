/**
 * ALERTS — bot commands (pure apart from the injected `read`). Every command replies; nothing is done silently.
 *
 *  /start                             register this chat (nothing is stored before /start)
 *  /watch <address> [tydro|nado]      watch a wallet (both venues unless one is named)
 *  /unwatch <address>                 stop watching it
 *  /list                              what this chat watches
 *  /pause  /resume                    hold / restart every alert for this chat
 *  /status [address]                  read now and show where things stand
 *  /hf <address> <value|off>          alert when Tydro HF falls below value (1.0–5)
 *  /buffer <address> <percent|off>    alert when the worst Nado margin buffer falls below percent (1–90)
 *  /scenario <address> <DIR> <±pct|off>  alert when that move would liquidate the wallet (e.g. ETH -20)
 *  /help                              this list
 *  /delete                            erase this chat and everything stored for it, now
 */
import { DIRECTIONS, directionById } from '@aegis/pose';
import { FOOTER_TEXT } from './text.js';
import { evaluate } from './engine.js';
import { riskLine, provenance, short, watchLine } from './format.js';
import { ALERTS, audit, checkWatchAddress, freshState, stateKey, type AlertsConfig, type AlertsDb, type Chat, type Observation, type Watch } from './model.js';
import { BRAND } from '@aegis/glyphs';

export const COMMANDS = ['start', 'watch', 'unwatch', 'list', 'pause', 'resume', 'status', 'hf', 'buffer', 'scenario', 'protocol', 'help', 'delete'] as const;
export type Command = (typeof COMMANDS)[number];

export type Parsed = { ok: true; cmd: Command; args: string[] } | { ok: false; why: string };

/** "/watch@ExampleBot 0xabc tydro" → { cmd: 'watch', args: ['0xabc', 'tydro'] }. Plain text that isn't a command is ignored. */
export function parseCommand(text: string): Parsed | null {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  const [head, ...rest] = t.split(/\s+/);
  const name = head!.slice(1).split('@')[0]!.toLowerCase();
  if (!(COMMANDS as readonly string[]).includes(name)) return { ok: false, why: `Unknown command /${name}. Send /help for the list.` };
  return { ok: true, cmd: name as Command, args: rest.slice(0, 6) };
}

export interface CommandDeps {
  now: number;
  fixtures: ReadonlySet<string>;
  siteUrl: string;
  /** salted hash of a chat id, for the audit log */
  hashChat: (chatId: string) => string;
  /** read a wallet now (null = couldn't read at all) */
  read: (address: string, scenarios: ReadonlyArray<Watch['scenario']>) => Promise<Observation | null>;
  cfg?: AlertsConfig;
}

export const HELP_TEXT = [
  `${BRAND.display} alerts — read-only risk intelligence on Ink wallets (Tydro and Nado).`,
  'Phrourax never asks for keys, never connects to a wallet and cannot move funds.',
  '',
  '/watch <address> [tydro|nado] — watch a wallet',
  '/unwatch <address> — stop watching it',
  '/list — what you watch',
  '/status [address] — read now',
  '/hf <address> <1.0–5 | off> — alert when Tydro HF falls below',
  '/buffer <address> <1–90 | off> — alert when the worst Nado margin buffer (%) falls below',
  `/scenario <address> <${DIRECTIONS.map((d) => d.id).join('|')}> <±pct | off> — alert when that move would liquidate it`,
  '/protocol <on | off> — also tell me about Ink-wide oracle problems and Tydro/Nado parameter changes',
  '/pause, /resume — hold or restart your alerts',
  '/delete — erase this chat and everything stored for it',
  '',
  "You're told when a watched wallet's risk level changes (SAFE → WATCH → NEAR → LIQUIDATABLE and back), when its classification changes, when Phrourax can't read it, and when a reading is stale or partial. Messages never include balances.",
  'Alerts are checked on a schedule, not instantly — a message can arrive minutes after the chain moved. Do not rely on it as your only warning.',
  FOOTER_TEXT,
].join('\n');

const findWatch = (chat: Chat, a: string) => chat.watches.find((w) => w.address === a);

export async function handleCommand(db: AlertsDb, chatId: string, text: string, deps: CommandDeps): Promise<string | null> {
  const cfg = deps.cfg ?? ALERTS;
  const p = parseCommand(text);
  if (p === null) return null;
  const h = deps.hashChat(chatId);
  if (!p.ok) return p.why;
  audit(db, { at: deps.now, chat: h, kind: 'command', detail: p.cmd }, cfg);
  const chat = db.chats[chatId];

  if (p.cmd === 'help') return HELP_TEXT;
  if (p.cmd === 'start') {
    if (chat) return `Already set up. ${chat.watches.length} wallet(s) watched.${chat.paused ? ' Alerts are PAUSED — /resume to restart.' : ''}\n\n${HELP_TEXT}`;
    if (Object.keys(db.chats).length >= cfg.MAX_CHATS) {
      audit(db, { at: deps.now, chat: h, kind: 'limit', detail: 'MAX_CHATS' }, cfg);
      return 'Phrourax alerts are full right now — no new chats can be added. Nothing about you was stored.';
    }
    db.chats[chatId] = { id: chatId, createdAt: deps.now, paused: false, watches: [], sentAt: [], held: 0 };
    return `Set up. Stored: this chat's id and the wallets you add — nothing else. /delete erases it all.\n\n${HELP_TEXT}`;
  }
  if (!chat) return 'Send /start first. Nothing is stored until you do.';

  if (p.cmd === 'delete') {
    for (const k of Object.keys(db.state)) if (k.startsWith(`${chatId}|`)) delete db.state[k];
    delete db.chats[chatId];
    audit(db, { at: deps.now, chat: h, kind: 'deleted', detail: 'chat and all its watches erased' }, cfg);
    return 'Erased: this chat and every wallet it watched. Nothing about it remains in Phrourax alerts. /start to begin again.';
  }
  if (p.cmd === 'protocol') {
    const v = (p.args[0] ?? '').toLowerCase();
    if (v !== 'on' && v !== 'off') return `Protocol alerts are ${chat.protocol ? 'ON' : 'OFF'}. /protocol on or /protocol off.`;
    chat.protocol = v === 'on';
    if (chat.protocol) {
      chat.protocolSince = deps.now;
      chat.seenProtocol = [];
    }
    return chat.protocol
      ? 'Protocol alerts ON: oracle problems (stale, diverging or depegged prices, sudden jumps) and Tydro/Nado parameter changes, from now on. /protocol off to stop.'
      : 'Protocol alerts OFF.';
  }
  if (p.cmd === 'pause') {
    chat.paused = true;
    return 'Paused. No alerts until /resume. (Your watches are kept; /delete erases them.)';
  }
  if (p.cmd === 'resume') {
    chat.paused = false;
    return `Resumed. Watching ${chat.watches.length} wallet(s).`;
  }
  if (p.cmd === 'list') {
    if (!chat.watches.length) return 'Watching nothing yet. /watch <address> to add a wallet.';
    return [`Watching ${chat.watches.length} of ${cfg.MAX_WATCHES_PER_CHAT}${chat.paused ? ' (PAUSED)' : ''}:`, ...chat.watches.map((w) => `• ${watchLine(w)}`)].join('\n');
  }

  // everything below names an address (status may omit it)
  const raw = p.args[0];
  if (p.cmd === 'status' && !raw) {
    if (!chat.watches.length) return 'Watching nothing yet. /watch <address> to add a wallet.';
    const lines = [`${chat.paused ? 'PAUSED · ' : ''}Last known state (send /status <address> to read one now):`];
    for (const w of chat.watches) {
      const st = db.state[stateKey(chatId, w.address)];
      lines.push(`• ${short(w.address)} — ${st?.level ?? 'not read yet'}${st?.lastCheckedAt ? ` · checked ${Math.round((deps.now - st.lastCheckedAt) / 60_000)} min ago` : ''}`);
    }
    if (db.lastRun) lines.push(`Last alerts run: ${Math.round((deps.now - db.lastRun.at) / 60_000)} min ago${db.lastRun.ok ? '' : ' (had problems)'}`);
    return lines.join('\n');
  }
  if (!raw) return `Which wallet? /${p.cmd} <address>`;
  const chk = checkWatchAddress(raw, deps.fixtures);
  if (!chk.ok) {
    audit(db, { at: deps.now, chat: h, kind: 'rejected', detail: `${p.cmd}: ${chk.why}` }, cfg);
    return chk.why;
  }
  const a = chk.address;

  if (p.cmd === 'watch') {
    const venueArg = (p.args[1] ?? 'any').toLowerCase();
    if (!['any', 'tydro', 'nado'].includes(venueArg)) return 'Venue must be tydro or nado (or leave it out for both).';
    const existing = findWatch(chat, a);
    if (existing) {
      existing.venue = venueArg as Watch['venue'];
      return `Already watching ${short(a)} — venue set to ${venueArg === 'any' ? 'both' : venueArg}.`;
    }
    if (chat.watches.length >= cfg.MAX_WATCHES_PER_CHAT) {
      audit(db, { at: deps.now, chat: h, kind: 'limit', detail: 'MAX_WATCHES_PER_CHAT' }, cfg);
      return `You're watching the maximum of ${cfg.MAX_WATCHES_PER_CHAT} wallets. /unwatch one first.`;
    }
    const w: Watch = { address: a, venue: venueArg as Watch['venue'], hfBelow: null, bufferBelow: null, scenario: null, createdAt: deps.now };
    chat.watches.push(w);
    // baseline now, so the first run doesn't announce the current state as news
    const obs = await deps.read(a, []).catch(() => null);
    const k = stateKey(chatId, a);
    if (obs) db.state[k] = evaluate(w, freshState(), obs, deps.now, cfg).next;
    return [`Watching ${short(a)}${venueArg === 'any' ? '' : ` (${venueArg} only)`}.`, obs ? riskLine(obs) : "Couldn't read it just now — it will be read on the next run.", ...(obs ? provenance(obs, deps.now) : [])].join('\n');
  }

  const w = findWatch(chat, a);
  if (p.cmd === 'unwatch') {
    if (!w) return `Not watching ${short(a)}.`;
    chat.watches = chat.watches.filter((x) => x !== w);
    delete db.state[stateKey(chatId, a)];
    return `Stopped watching ${short(a)}. Its alert state is erased.`;
  }
  if (p.cmd === 'status') {
    const obs = await deps.read(a, w?.scenario ? [w.scenario] : []).catch(() => null);
    if (!obs) return `Couldn't read ${short(a)} just now. Try again shortly.`;
    return [`Phrourax · ${short(a)}${w ? '' : ' (not watched)'}`, riskLine(obs), ...provenance(obs, deps.now), `${deps.siteUrl.replace(/\/$/, '')}/hull/${a}`].join('\n');
  }
  if (!w) return `Not watching ${short(a)} — /watch it first.`;
  const st = db.state[stateKey(chatId, a)];
  const arg = (p.args[1] ?? '').toLowerCase();

  if (p.cmd === 'hf') {
    if (arg === 'off') {
      w.hfBelow = null;
      return `HF alert off for ${short(a)}.`;
    }
    const v = Number(arg);
    if (!Number.isFinite(v) || v <= cfg.HF_MIN || v > cfg.HF_MAX) return `HF must be above ${cfg.HF_MIN} and at most ${cfg.HF_MAX} (e.g. /hf ${short(a)} 1.2), or off.`;
    w.hfBelow = Math.round(v * 100) / 100;
    if (st) st.hfArmed = true;
    return `Will alert when ${short(a)}'s Tydro HF falls below ${w.hfBelow.toFixed(2)} (re-arms above ${(w.hfBelow + cfg.HF_HYSTERESIS).toFixed(2)}).`;
  }
  if (p.cmd === 'buffer') {
    if (arg === 'off') {
      w.bufferBelow = null;
      return `Buffer alert off for ${short(a)}.`;
    }
    const v = Number(arg.replace('%', ''));
    if (!Number.isFinite(v) || v < cfg.BUFFER_MIN_PCT || v > cfg.BUFFER_MAX_PCT) return `Buffer must be ${cfg.BUFFER_MIN_PCT}–${cfg.BUFFER_MAX_PCT} (percent), or off.`;
    w.bufferBelow = Math.round(v * 10) / 1000;
    if (st) st.bufferArmed = true;
    return `Will alert when ${short(a)}'s worst Nado margin buffer falls below ${(w.bufferBelow * 100).toFixed(1)}%.`;
  }
  // scenario
  if (arg === 'off') {
    w.scenario = null;
    if (st) st.scenarioHit = null;
    return `Scenario alert off for ${short(a)}.`;
  }
  const d = directionById((p.args[1] ?? '').toUpperCase());
  if (!d) return `Direction must be one of ${DIRECTIONS.map((x) => x.id).join(', ')} — e.g. /scenario ${short(a)} ETH -20`;
  const pct = Number((p.args[2] ?? '').replace('%', ''));
  if (!Number.isFinite(pct) || pct === 0 || Math.abs(pct) > cfg.SCENARIO_MAX_PCT || !Number.isInteger(pct)) return `Move must be a whole percent between -${cfg.SCENARIO_MAX_PCT} and +${cfg.SCENARIO_MAX_PCT}, not 0 (e.g. -20).`;
  if (d.downOnly && pct > 0) return `${d.label} only goes down — use a negative move.`;
  w.scenario = { direction: d.id, pct };
  if (st) st.scenarioHit = null;
  return `Will alert when ${d.label} ${pct > 0 ? '+' : ''}${pct}% would liquidate ${short(a)} (modelled with the same engine as the Pressure Map; not a prediction).`;
}
