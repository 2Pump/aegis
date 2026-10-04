/**
 * ALERTS — domain model (pure; no IO).
 *
 * A person messages the AEGIS bot, picks wallets to watch, and gets a Telegram message when something about one of
 * those wallets changes. Read-only like everything else: AEGIS reads the chain and sends a message. It never asks
 * for a key, never connects a wallet, never signs, never moves funds.
 *
 * Privacy:
 *  - a message never carries balances or position sizes — only the risk level, HF / margin buffer, data age and block;
 *  - chat ids live only in the alerts store, which is encrypted at rest (AES-256-GCM, key server-side only);
 *  - the audit log names chats by a salted hash, never the raw id;
 *  - /delete wipes a chat's watches and state immediately.
 */
import type { HullTemp, Tag } from '@aegis/pose';

export const ALERTS = {
  VERSION: 'alerts-1.0.0',
  /** wallets one chat may watch */
  MAX_WATCHES_PER_CHAT: 10,
  /** chats the bot will accept (a public bot must not grow without bound on free infrastructure) */
  MAX_CHATS: 500,
  /** distinct wallets read per run; the rest wait for the next run (oldest-checked first) */
  MAX_ADDRESSES_PER_RUN: 300,
  /** the same alert (same chat, wallet, kind and level) is not repeated within this window */
  COOLDOWN_MIN: 60,
  /** messages per chat per rolling hour; beyond that alerts are held and counted, never silently dropped */
  MAX_MSGS_PER_CHAT_PER_HOUR: 6,
  /** a lower risk level must be seen on this many runs in a row before a recovery is announced (no flapping) */
  RECOVERY_CONFIRM_RUNS: 2,
  /** HF must climb this far above the user's threshold before the threshold re-arms */
  HF_HYSTERESIS: 0.05,
  /** margin buffer must climb this far (absolute fraction) above the user's threshold before it re-arms */
  BUFFER_HYSTERESIS: 0.02,
  /** chain data older than this is STALE: an alert says so instead of pretending it is current */
  STALE_MIN: 30,
  /** a venue must be unreadable on this many runs in a row before "can't read" is sent */
  UNREADABLE_CONFIRM_RUNS: 2,
  /** audit entries kept (oldest trimmed beyond this — the audit is an operations log, not an archive of people) */
  AUDIT_MAX: 5000,
  /** a message that failed with a retryable error is tried this many times in all, then dropped (and audited) */
  MAX_SEND_ATTEMPTS: 3,
  /** wallets read at once */
  READ_CONCURRENCY: 4,
  /** user threshold bounds */
  HF_MIN: 1.0,
  HF_MAX: 5,
  BUFFER_MIN_PCT: 1,
  BUFFER_MAX_PCT: 90,
  SCENARIO_MAX_PCT: 90,
} as const;

export type AlertsConfig = { -readonly [K in keyof typeof ALERTS]: (typeof ALERTS)[K] extends number ? number : string };

export type WatchVenue = 'any' | 'tydro' | 'nado';

export interface Watch {
  /** lower-case 0x address */
  address: string;
  venue: WatchVenue;
  /** alert when Tydro HF falls below this; null = off */
  hfBelow: number | null;
  /** alert when the worst Nado subaccount's margin buffer falls below this fraction; null = off */
  bufferBelow: number | null;
  /** alert when this hypothetical move would liquidate the wallet; null = off */
  scenario: { direction: string; pct: number } | null;
  createdAt: number;
}

export interface Chat {
  /** Telegram chat id, as a string. Encrypted at rest with the rest of the store. */
  id: string;
  createdAt: number;
  paused: boolean;
  watches: Watch[];
  /** send times in the last hour (rate limit) */
  sentAt: number[];
  /** alerts held back by the rate limit since the last delivered message */
  held: number;
  /** opted in to Ink-wide protocol alerts (oracle problems, protocol parameter changes) with /protocol on */
  protocol?: boolean;
  /** protocol events already delivered (ids, newest last, bounded) */
  seenProtocol?: string[];
  /** only protocol events from this time on (no backlog when someone opts in) */
  protocolSince?: number;
}

/** Risk level used by alerts — the same ladder as the well and the Pressure Map. */
export type AlertLevel = 'SAFE' | 'WATCH' | 'NEAR' | 'LIQ' | 'UNKNOWN';
export const LEVEL_RANK: Record<AlertLevel, number> = { UNKNOWN: -1, SAFE: 0, WATCH: 1, NEAR: 2, LIQ: 3 };
export const LEVEL_TEXT: Record<AlertLevel, string> = {
  SAFE: 'SAFE',
  WATCH: 'WATCH',
  NEAR: 'NEAR LIQUIDATION',
  LIQ: 'LIQUIDATABLE',
  UNKNOWN: 'UNKNOWN',
};

/** One reading of one wallet, reduced to what alerts need. No balances. */
export interface Observation {
  address: string;
  /** when the reading was made (ms) */
  readAt: number;
  /** chain time of the block read (ms); null = unknown */
  dataAt: number | null;
  block: number | null;
  tydro: { readable: boolean; active: boolean; hf: number | null };
  nado: { readable: boolean; active: boolean; worstBuffer: number | null; partial: boolean };
  level: AlertLevel;
  hullTemp: HullTemp;
  primary: Tag | null;
  approximate: boolean;
  rulesVersion: string;
  engineVersion: string;
  /** per watched scenario key ("ETH:-20") → would that move liquidate the wallet? null = could not be modelled */
  scenarios: Record<string, boolean | null>;
}

/** What the engine remembers per (chat, wallet) between runs. */
export interface WatchState {
  level: AlertLevel | null;
  /** a pending lower level and how many runs in a row it has been seen */
  pendingDown: { level: AlertLevel; runs: number } | null;
  primary: Tag | null;
  hfArmed: boolean;
  bufferArmed: boolean;
  scenarioHit: boolean | null;
  unreadableRuns: { tydro: number; nado: number };
  unreadableSent: { tydro: boolean; nado: boolean };
  staleSent: boolean;
  partialSent: boolean;
  lastBlock: number | null;
  lastCheckedAt: number | null;
  /** dedup key → last sent (ms) */
  lastSent: Record<string, number>;
}

export const freshState = (): WatchState => ({
  level: null,
  pendingDown: null,
  primary: null,
  hfArmed: true,
  bufferArmed: true,
  scenarioHit: null,
  unreadableRuns: { tydro: 0, nado: 0 },
  unreadableSent: { tydro: false, nado: false },
  staleSent: false,
  partialSent: false,
  lastBlock: null,
  lastCheckedAt: null,
  lastSent: {},
});

export type AlertKind =
  | 'LEVEL_UP'
  | 'RECOVERED'
  | 'HF_BELOW'
  | 'HF_RECOVERED'
  | 'BUFFER_BELOW'
  | 'BUFFER_RECOVERED'
  | 'CLASS_CHANGE'
  | 'UNREADABLE'
  | 'READABLE_AGAIN'
  | 'STALE'
  | 'PARTIAL'
  | 'SCENARIO_LIQ'
  | 'SCENARIO_CLEAR';

export interface AlertEvent {
  kind: AlertKind;
  address: string;
  /** what makes two alerts "the same" for dedup: kind + this */
  detail: string;
  /** level-related context for the message */
  from?: AlertLevel | null;
  to?: AlertLevel;
  venue?: 'tydro' | 'nado';
  threshold?: number;
  scenario?: { direction: string; pct: number };
  fromTag?: Tag | null;
  toTag?: Tag | null;
  /** LIQ and first-crossing NEAR bypass the cooldown — never hold back the worst news */
  urgent: boolean;
}

export interface AuditEntry {
  at: number;
  /** salted hash of the chat id (never the id) */
  chat: string;
  kind: 'command' | 'alert' | 'held' | 'delivery-failed' | 'chat-blocked' | 'deleted' | 'rejected' | 'limit';
  detail: string;
}

export interface AlertsDb {
  v: 1;
  createdAt: number;
  chats: Record<string, Chat>;
  /** `${chatId}|${address}` → state */
  state: Record<string, WatchState>;
  /** transport cursor (Telegram getUpdates offset) */
  cursor: number;
  /** wallet → last time it was read by the runner (fair rotation when over MAX_ADDRESSES_PER_RUN) */
  checked: Record<string, number>;
  audit: AuditEntry[];
  /** messages whose delivery failed with a retryable error; retried on the next runs (MAX_SEND_ATTEMPTS) */
  outbox: Array<{ chatId: string; text: string; attempts: number; firstAt: number }>;
  lastRun: { at: number; ok: boolean; reads: number; sent: number; held: number; failed: number; note: string } | null;
}

export const emptyDb = (now: number): AlertsDb => ({ v: 1, createdAt: now, chats: {}, state: {}, cursor: 0, checked: {}, audit: [], outbox: [], lastRun: null });

/** Refuses anything that isn't an alerts db (a corrupt or foreign blob must not be half-trusted). */
export function isAlertsDb(x: unknown): x is AlertsDb {
  const d = x as AlertsDb;
  return !!d && d.v === 1 && typeof d.chats === 'object' && d.chats !== null && typeof d.state === 'object' && d.state !== null && Array.isArray(d.audit) && typeof d.cursor === 'number';
}

export const stateKey = (chatId: string, address: string) => `${chatId}|${address.toLowerCase()}`;
export const scenarioKey = (s: { direction: string; pct: number }) => `${s.direction}:${s.pct}`;

export function audit(db: AlertsDb, e: AuditEntry, cfg: Pick<AlertsConfig, 'AUDIT_MAX'> = ALERTS): void {
  db.audit.push(e);
  if (db.audit.length > cfg.AUDIT_MAX) db.audit.splice(0, db.audit.length - cfg.AUDIT_MAX);
}

/* ───────────────────────── addresses ───────────────────────── */

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export type AddressCheck = { ok: true; address: string } | { ok: false; why: string };

/**
 * A wallet anyone may watch: a well-formed 0x address that isn't the zero address and isn't one of AEGIS's own
 * synthetic test wallets (fixtures are never treated as real accounts).
 */
export function checkWatchAddress(raw: string, fixtures: ReadonlySet<string>): AddressCheck {
  const a = raw.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return { ok: false, why: "That isn't a wallet address (0x followed by 40 hex characters)." };
  if (a === ZERO_ADDRESS) return { ok: false, why: "That's the zero address — nobody's wallet." };
  if (fixtures.has(a)) return { ok: false, why: "That's one of AEGIS's synthetic test wallets, not a real account — it can't be watched." };
  return { ok: true, address: a };
}
