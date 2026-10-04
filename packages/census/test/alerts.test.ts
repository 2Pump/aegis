import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Book } from '@aegis/pose';
import {
  ALERTS,
  FOOTER_TEXT,
  TestTransport,
  admit,
  checkWatchAddress,
  emptyDb,
  evaluate,
  formatAlert,
  freshState,
  handleCommand,
  observe,
  parseCommand,
  rateAllow,
  runAlerts,
  stateKey,
  type AlertLevel,
  type AlertsDb,
  type Chat,
  type Observation,
  type Watch,
} from '../src/alerts/index.js';
import { chatHasher, checkAlertsEnv, fileAlertsStore, memoryAlertsStore, parseStoreKey, seal, telegramTransport, unseal } from '../src/node/index.js';

const A = '0x00000000000000000000000000000000000a1e71';
const B = '0x00000000000000000000000000000000000a1e72';
const FIX = new Set(['0x0000000000000000000000000000000000ae6004']);
const T0 = Date.UTC(2026, 9, 4, 12);
const MIN = 60_000;

const obs = (o: Partial<Observation> & { level?: AlertLevel } = {}): Observation => ({
  address: A,
  readAt: T0,
  dataAt: T0 - 30_000,
  block: 1_000,
  tydro: { readable: true, active: true, hf: 1.8 },
  nado: { readable: true, active: false, worstBuffer: null, partial: false },
  level: 'SAFE',
  hullTemp: 'NOMINAL',
  primary: 'CARRY' as never,
  approximate: false,
  rulesVersion: 'r-test',
  engineVersion: 'e-test',
  scenarios: {},
  ...o,
});
const watch = (w: Partial<Watch> = {}): Watch => ({ address: A, venue: 'any', hfBelow: null, bufferBelow: null, scenario: null, createdAt: T0, ...w });
const kinds = (r: { events: { kind: string }[] }) => r.events.map((e) => e.kind);

/** run a sequence of observations through the engine, returning each step's event kinds */
function seq(w: Watch, list: Observation[]) {
  let st = freshState();
  return list.map((o0, i) => {
    const now = T0 + i * 10 * MIN;
    const o = o0.dataAt === T0 - 30_000 ? { ...o0, readAt: now, dataAt: now - 30_000 } : o0;
    const r = evaluate(w, st, o, now);
    st = r.next;
    return kinds(r);
  });
}

describe('alerts · addresses', () => {
  it('accepts a wallet, rejects junk, the zero address and AEGIS fixtures', () => {
    expect(checkWatchAddress(` ${A.toUpperCase().replace('0X', '0x')} `, FIX)).toEqual({ ok: true, address: A });
    expect(checkWatchAddress('0x123', FIX).ok).toBe(false);
    expect(checkWatchAddress('0x0000000000000000000000000000000000000000', FIX).ok).toBe(false);
    const f = checkWatchAddress('0x0000000000000000000000000000000000AE6004', FIX);
    expect(f.ok === false && f.why).toMatch(/synthetic test wallet/);
  });
});

describe('alerts · transitions', () => {
  it('first reading is a baseline (no news) unless already near the line', () => {
    expect(seq(watch(), [obs({ level: 'WATCH' })])).toEqual([[]]);
    expect(seq(watch(), [obs({ level: 'NEAR' })])).toEqual([['LEVEL_UP']]);
  });

  it('SAFE → WATCH → NEAR → LIQ fire immediately on the way up', () => {
    expect(seq(watch(), [obs(), obs({ level: 'WATCH' }), obs({ level: 'NEAR' }), obs({ level: 'LIQ' })])).toEqual([[], ['LEVEL_UP'], ['LEVEL_UP'], ['LEVEL_UP']]);
  });

  it('recovery needs consecutive confirmations (hysteresis): no flapping on a wallet sitting on a line', () => {
    const steps = seq(watch(), [obs({ level: 'NEAR' }), obs({ level: 'WATCH' }), obs({ level: 'NEAR' }), obs({ level: 'WATCH' }), obs({ level: 'WATCH' })]);
    expect(steps).toEqual([['LEVEL_UP'], [], [], [], ['RECOVERED']]);
  });

  it('a recovery announces the least-recovered level seen while pending', () => {
    let st = freshState();
    for (const l of ['LIQ', 'WATCH', 'SAFE'] as AlertLevel[]) st = evaluate(watch(), st, obs({ level: l }), T0).next;
    expect(st.level).toBe('WATCH');
  });

  it('UNKNOWN never counts as safe and never triggers a recovery', () => {
    expect(seq(watch(), [obs({ level: 'NEAR' }), obs({ level: 'UNKNOWN' }), obs({ level: 'UNKNOWN' })])).toEqual([['LEVEL_UP'], [], []]);
  });

  it('HF threshold fires once on crossing, re-arms only above threshold + hysteresis', () => {
    const w = watch({ hfBelow: 1.2 });
    const hf = (x: number | null) => obs({ tydro: { readable: true, active: true, hf: x } });
    expect(seq(w, [hf(1.3), hf(1.19), hf(1.1), hf(1.22), hf(1.19), hf(1.26), hf(1.15)])).toEqual([[], ['HF_BELOW'], [], [], [], ['HF_RECOVERED'], ['HF_BELOW']]);
  });

  it('buffer threshold uses the WORST Nado subaccount, with hysteresis', () => {
    const w = watch({ bufferBelow: 0.1 });
    const b = (x: number) => obs({ nado: { readable: true, active: true, worstBuffer: x, partial: false } });
    expect(seq(w, [b(0.2), b(0.08), b(0.11), b(0.13)])).toEqual([[], ['BUFFER_BELOW'], [], ['BUFFER_RECOVERED']]);
  });

  it('venue filter: a Nado-only watch ignores Tydro readability and HF', () => {
    const w = watch({ venue: 'nado', hfBelow: 1.5 });
    const dead = obs({ tydro: { readable: false, active: false, hf: null } });
    expect(seq(w, [obs({ tydro: { readable: true, active: true, hf: 1.1 } }), dead, dead])).toEqual([[], [], []]);
  });

  it('classification change is reported (not on the first reading)', () => {
    expect(seq(watch(), [obs(), obs({ primary: 'NAKED' as never })])).toEqual([[], ['CLASS_CHANGE']]);
  });

  it('unreadable is confirmed over consecutive runs, said once, and recovery is said', () => {
    const dead = obs({ tydro: { readable: false, active: false, hf: null }, level: 'UNKNOWN' });
    expect(seq(watch(), [obs(), dead, dead, dead, obs()])).toEqual([[], [], ['UNREADABLE'], [], ['READABLE_AGAIN']]);
  });

  it('stale data is said once and never presented as current', () => {
    const old = obs({ dataAt: T0 - 3 * 3600_000 });
    const r = evaluate(watch(), freshState(), old, T0);
    expect(kinds(r)).toEqual(['STALE']);
    expect(formatAlert(r.events, old, { now: T0, siteUrl: 'https://x.test', alertsVersion: ALERTS.VERSION })).toMatch(/STALE: the chain data AEGIS could read is 3 h old/);
    expect(kinds(evaluate(watch(), r.next, old, T0))).toEqual([]);
  });

  it('partial Nado readings are flagged once', () => {
    const p = obs({ nado: { readable: true, active: true, worstBuffer: 0.4, partial: true } });
    expect(seq(watch(), [p, p])).toEqual([['PARTIAL'], []]);
  });

  it('scenario: fires when the move would liquidate, clears when it no longer would; unmodellable keeps state', () => {
    const w = watch({ scenario: { direction: 'ETH', pct: -20 } });
    const s = (v: boolean | null) => obs({ scenarios: { 'ETH:-20': v } });
    expect(seq(w, [s(false), s(true), s(null), s(true), s(false)])).toEqual([[], ['SCENARIO_LIQ'], [], [], ['SCENARIO_CLEAR']]);
  });
});

describe('alerts · dedup, cooldown, rate limit', () => {
  it('the same alert is not repeated inside the cooldown; urgent ones always go', () => {
    const st = freshState();
    const e = { kind: 'CLASS_CHANGE' as const, address: A, detail: 'x>y', urgent: false };
    expect(admit([e, e], st, T0).send).toHaveLength(1);
    expect(admit([e], st, T0 + 10 * MIN).cooled).toHaveLength(1);
    expect(admit([e], st, T0 + (ALERTS.COOLDOWN_MIN + 1) * MIN).send).toHaveLength(1);
    const u = { kind: 'LEVEL_UP' as const, address: A, detail: 'LIQ', urgent: true };
    admit([u], st, T0);
    expect(admit([u], st, T0 + MIN).send).toHaveLength(1);
  });

  it('per-chat hourly cap; urgent passes', () => {
    const chat: Chat = { id: '1', createdAt: 0, paused: false, watches: [], sentAt: Array.from({ length: ALERTS.MAX_MSGS_PER_CHAT_PER_HOUR }, () => T0 - MIN), held: 0 };
    expect(rateAllow(chat, T0, false)).toBe(false);
    expect(rateAllow(chat, T0, true)).toBe(true);
    expect(rateAllow(chat, T0 + 2 * 3600_000, false)).toBe(true);
  });
});

describe('alerts · messages', () => {
  it('carry level, HF/buffer, data age, block, link, labels, versions and the footer — never balances', () => {
    const o = obs({ level: 'NEAR', approximate: true, tydro: { readable: true, active: true, hf: 1.04 }, nado: { readable: true, active: true, worstBuffer: 0.031, partial: true } });
    const txt = formatAlert([{ kind: 'LEVEL_UP', address: A, detail: 'NEAR', from: 'WATCH', to: 'NEAR', urgent: true }], o, { now: T0, siteUrl: 'https://aegis.test/', alertsVersion: ALERTS.VERSION, held: 2 });
    expect(txt).toMatch(/NEAR LIQUIDATION \(was WATCH/);
    expect(txt).toMatch(/Tydro HF 1\.04/);
    expect(txt).toMatch(/Nado buffer 3\.1% \(worst subaccount\)/);
    expect(txt).toMatch(/APPROXIMATE · PARTIAL \(Nado\)/);
    expect(txt).toMatch(/block 1,000 · under a minute old/);
    expect(txt).toContain(`https://aegis.test/hull/${A}`);
    expect(txt).toMatch(/rules r-test · engine e-test · alerts alerts-1/);
    expect(txt).toMatch(/2 other alerts held back/);
    expect(txt.endsWith(FOOTER_TEXT)).toBe(true);
    expect(txt).not.toMatch(/\$|USD|usd|balance|collateral \d/i);
  });

  it('footer text matches the site footer verbatim', () => {
    expect(FOOTER_TEXT).toBe('AEGIS is a camera. It cannot move your funds. Classifications can be wrong.');
  });
});

describe('alerts · observe (same engine as the site)', () => {
  const book = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/${name}.json`, import.meta.url), 'utf8')) as Book;
  it('wounded fixture → NEAR or LIQ; carry → not near; dark → venue unreadable', () => {
    expect(['NEAR', 'LIQ']).toContain(observe(book('wounded'), { readAt: T0, dataAt: null, scenarios: [] }).level);
    expect(['SAFE', 'WATCH']).toContain(observe(book('carry'), { readAt: T0, dataAt: null, scenarios: [] }).level);
    const d = observe(book('dark'), { readAt: T0, dataAt: null, scenarios: [] });
    expect(d.tydro.readable && d.nado.readable).toBe(false);
  });
  it('scenarios are evaluated with the scenario engine; unknown direction → null (not modelled)', () => {
    const o = observe(book('carry'), { readAt: T0, dataAt: null, scenarios: [{ direction: 'ETH', pct: -90 }, { direction: 'NOPE', pct: -10 }] });
    expect(typeof o.scenarios['ETH:-90']).toBe('boolean');
    expect(o.scenarios['NOPE:-10']).toBeNull();
  });
});

const deps = (read: (a: string) => Observation | null) => ({
  now: T0,
  fixtures: FIX,
  siteUrl: 'https://aegis.test',
  hashChat: (c: string) => `h${c}`,
  read: async (a: string) => read(a),
});

describe('alerts · commands', () => {
  it('parses commands, including @BotName suffixes; plain text is ignored', () => {
    expect(parseCommand('/watch@AegisBot 0xabc tydro')).toEqual({ ok: true, cmd: 'watch', args: ['0xabc', 'tydro'] });
    expect(parseCommand('hello')).toBeNull();
    expect(parseCommand('/sell 0xabc')).toMatchObject({ ok: false });
  });

  it('nothing is stored before /start; /start, /watch, /list, /hf, /buffer, /scenario, /pause, /resume, /unwatch, /delete', async () => {
    const db = emptyDb(T0);
    const d = deps(() => obs());
    expect(await handleCommand(db, '7', `/watch ${A}`, d)).toMatch(/\/start first/);
    expect(db.chats['7']).toBeUndefined();
    expect(await handleCommand(db, '7', '/start', d)).toMatch(/Set up/);
    expect(await handleCommand(db, '7', `/watch ${A}`, d)).toMatch(/Watching 0x0000…1e71[\s\S]*Risk now: SAFE/);
    expect(db.state[stateKey('7', A)]?.level).toBe('SAFE'); // baselined
    expect(await handleCommand(db, '7', '/watch 0x0000000000000000000000000000000000ae6004', d)).toMatch(/synthetic/);
    expect(await handleCommand(db, '7', `/hf ${A} 0.9`, d)).toMatch(/above 1/);
    expect(await handleCommand(db, '7', `/hf ${A} 1.25`, d)).toMatch(/below 1\.25/);
    expect(await handleCommand(db, '7', `/buffer ${A} 15`, d)).toMatch(/15\.0%/);
    expect(await handleCommand(db, '7', `/scenario ${A} USDC 10`, d)).toMatch(/only goes down/);
    expect(await handleCommand(db, '7', `/scenario ${A} ETH -20`, d)).toMatch(/ETH -20%/);
    expect(await handleCommand(db, '7', '/list', d)).toMatch(/HF < 1\.25, buffer < 15\.0%, scenario ETH -20%/);
    expect(await handleCommand(db, '7', '/pause', d)).toMatch(/Paused/);
    expect(db.chats['7']!.paused).toBe(true);
    expect(await handleCommand(db, '7', '/resume', d)).toMatch(/Resumed/);
    expect(await handleCommand(db, '7', `/status ${B}`, d)).toMatch(/not watched/);
    expect(await handleCommand(db, '7', `/unwatch ${A}`, d)).toMatch(/Stopped/);
    expect(db.state[stateKey('7', A)]).toBeUndefined();
    await handleCommand(db, '7', `/watch ${A}`, d);
    expect(await handleCommand(db, '7', '/delete', d)).toMatch(/Erased/);
    expect(db.chats['7']).toBeUndefined();
    expect(Object.keys(db.state).some((k) => k.startsWith('7|'))).toBe(false);
    expect(JSON.stringify(db.audit)).not.toMatch(/"chat":"7"/); // audit names chats by hash only
  });

  it('enforces the per-chat watch limit and the chat cap', async () => {
    const db = emptyDb(T0);
    const d = { ...deps(() => obs()), cfg: { ...ALERTS, MAX_WATCHES_PER_CHAT: 1, MAX_CHATS: 1 } };
    await handleCommand(db, '1', '/start', d);
    await handleCommand(db, '1', `/watch ${A}`, d);
    expect(await handleCommand(db, '1', `/watch ${B}`, d)).toMatch(/maximum of 1/);
    expect(await handleCommand(db, '2', '/start', d)).toMatch(/full/);
    expect(db.chats['2']).toBeUndefined();
  });
});

describe('alerts · end-to-end run (test adapter)', () => {
  it('commands → baseline → transition → one message → cooldown → recovery; balances never sent', async () => {
    const tx = new TestTransport();
    let level: AlertLevel = 'SAFE';
    let hf = 1.8;
    let now = T0;
    const read = async (a: string) => obs({ address: a, level, tydro: { readable: true, active: true, hf }, readAt: now, dataAt: now - 20_000 });
    const d = { transport: tx, read, now: () => now, fixtures: FIX, siteUrl: 'https://aegis.test', hashChat: (c: string) => `h${c}` };
    let db: AlertsDb = emptyDb(T0);

    tx.say('42', '/start');
    tx.say('42', `/watch ${A}`);
    tx.say('42', `/hf ${A} 1.3`);
    ({ db } = await runAlerts(db, d));
    expect(tx.to('42')).toHaveLength(3); // three replies, no alert (baseline)

    // nothing changed → nothing sent
    now += 10 * MIN;
    ({ db } = await runAlerts(db, d));
    expect(tx.to('42')).toHaveLength(3);

    // level up + HF crossing in the same run → ONE message with both lines
    level = 'NEAR';
    hf = 1.1;
    now += 10 * MIN;
    const r = await runAlerts(db, d);
    db = r.db;
    const msgs = tx.to('42');
    expect(msgs).toHaveLength(4);
    expect(msgs[3]).toMatch(/NEAR LIQUIDATION \(was SAFE\)/);
    expect(msgs[3]).toMatch(/health factor 1\.10 — below your 1\.30/);
    expect(r.report.sent).toBe(1);

    // two healthy readings → recovery (hysteresis), HF re-armed
    level = 'SAFE';
    hf = 1.9;
    now += 10 * MIN;
    ({ db } = await runAlerts(db, d));
    now += 10 * MIN;
    ({ db } = await runAlerts(db, d));
    const last = tx.to('42').at(-1)!;
    expect(last).toMatch(/Back to SAFE/);
    expect(tx.sent.every((s) => !/\$\d|USD \d/.test(s.text))).toBe(true);
    expect(db.audit.some((x) => x.kind === 'alert')).toBe(true);
  });

  it('a wallet watched by two chats is read once per run', async () => {
    const tx = new TestTransport();
    let reads = 0;
    const d = { transport: tx, read: async (a: string) => (reads++, obs({ address: a })), now: () => T0, fixtures: FIX, siteUrl: 'https://x', hashChat: (c: string) => c };
    let db = emptyDb(T0);
    for (const c of ['1', '2']) {
      tx.say(c, '/start');
      tx.say(c, `/watch ${A}`);
    }
    ({ db } = await runAlerts(db, d));
    reads = 0;
    await runAlerts(db, d);
    expect(reads).toBe(1);
  });

  it('a blocked chat is erased; a retryable failure is retried next run, then given up', async () => {
    const tx = new TestTransport();
    let level: AlertLevel = 'SAFE';
    const d = { transport: tx, read: async (a: string) => obs({ address: a, level }), now: () => T0, fixtures: FIX, siteUrl: 'https://x', hashChat: (c: string) => c };
    let db = emptyDb(T0);
    for (const c of ['1', '2']) {
      tx.say(c, '/start');
      tx.say(c, `/watch ${A}`);
    }
    ({ db } = await runAlerts(db, d));
    tx.fail.set('1', { ok: false, retryable: false, blocked: true, error: 'Forbidden: bot was blocked by the user' });
    tx.fail.set('2', { ok: false, retryable: true, blocked: false, error: 'HTTP 502' });
    level = 'LIQ';
    ({ db } = await runAlerts(db, d));
    expect(db.chats['1']).toBeUndefined();
    expect(db.outbox).toHaveLength(1);
    tx.fail.delete('2');
    ({ db } = await runAlerts(db, d));
    expect(db.outbox).toHaveLength(0);
    expect(tx.to('2').at(-1)).toMatch(/LIQUIDATABLE/);
  });

  it('a read that throws becomes UNREADABLE (never "safe"), after confirmation', async () => {
    const tx = new TestTransport();
    let ok = true;
    let now = T0;
    const d = { transport: tx, read: async (a: string) => { if (!ok) throw new Error('rpc down'); return obs({ address: a }); }, now: () => now, fixtures: FIX, siteUrl: 'https://x', hashChat: (c: string) => c };
    let db = emptyDb(T0);
    tx.say('1', '/start');
    tx.say('1', `/watch ${A}`);
    ({ db } = await runAlerts(db, d));
    ok = false;
    for (let i = 0; i < 2; i++) {
      now += 10 * MIN;
      ({ db } = await runAlerts(db, d));
    }
    expect(tx.to('1').at(-1)).toMatch(/couldn't be read/);
    expect(tx.to('1').at(-1)).toMatch(/Risk now: UNKNOWN/);
  });

  it('paused chats get no alerts; rate-limited alerts are held, counted and mentioned later', async () => {
    const tx = new TestTransport();
    let lvl: AlertLevel = 'SAFE';
    let now = T0;
    const d = { transport: tx, read: async (a: string) => obs({ address: a, level: lvl, primary: (lvl === 'WATCH' ? 'NAKED' : 'CARRY') as never }), now: () => now, fixtures: FIX, siteUrl: 'https://x', hashChat: (c: string) => c, cfg: { ...ALERTS, MAX_MSGS_PER_CHAT_PER_HOUR: 0, COOLDOWN_MIN: 0 } };
    let db = emptyDb(T0);
    tx.say('1', '/start');
    tx.say('1', `/watch ${A}`);
    ({ db } = await runAlerts(db, d));
    const before = tx.to('1').length;
    lvl = 'WATCH'; // non-urgent → held by a 0/hour cap
    now += MIN;
    const r = await runAlerts(db, d);
    db = r.db;
    expect(tx.to('1').length).toBe(before);
    expect(r.report.held).toBeGreaterThan(0);
    expect(db.chats['1']!.held).toBeGreaterThan(0);
    lvl = 'LIQ'; // urgent → goes, and mentions what was held
    now += MIN;
    ({ db } = await runAlerts(db, d));
    expect(tx.to('1').at(-1)).toMatch(/held back by the rate limit/);
    db.chats['1']!.paused = true;
    lvl = 'SAFE';
    const n = tx.to('1').length;
    for (let i = 0; i < 3; i++) {
      now += MIN;
      ({ db } = await runAlerts(db, d));
    }
    expect(tx.to('1').length).toBe(n);
  });
});

describe('alerts · persistence and secrets', () => {
  const key = Buffer.alloc(32, 7);
  it('the store is encrypted at rest: chat ids are not in the stored bytes; wrong key refuses', async () => {
    const s = memoryAlertsStore(key);
    const db = emptyDb(T0);
    db.chats['555123987'] = { id: '555123987', createdAt: T0, paused: false, watches: [watch()], sentAt: [], held: 0 };
    await s.save(db);
    expect(JSON.stringify(s.raw())).not.toContain('555123987');
    expect(JSON.stringify(s.raw())).not.toContain(A);
    expect((await s.load())?.chats['555123987']?.watches[0]?.address).toBe(A);
    expect(() => unseal(Buffer.alloc(32, 8), s.raw())).toThrow(/could not decrypt/);
    const tampered = { ...(s.raw() as object), data: Buffer.from('x').toString('base64') };
    expect(() => unseal(key, tampered)).toThrow();
  });

  it('a decryptable object that is not an alerts db is refused (never overwritten as empty)', async () => {
    // the OS temp folder (C:\Users\…\Temp on Windows, /tmp on Linux) — never a hard-coded path
    const dir = mkdtempSync(join(tmpdir(), 'aegis-alerts-'));
    const p = join(dir, 'a.json');
    writeFileSync(p, JSON.stringify(seal(key, { hello: 1 })));
    await expect(fileAlertsStore(p, key).load()).rejects.toThrow(/not an alerts db/);
    expect(await fileAlertsStore(join(dir, 'none.json'), key).load()).toBeNull();
  });

  it('store key must be 32 bytes; chat hash is stable and not the id', () => {
    expect(() => parseStoreKey(undefined)).toThrow(/not set/);
    expect(() => parseStoreKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
    const h = chatHasher(key);
    expect(h('42')).toBe(h('42'));
    expect(h('42')).not.toContain('42');
  });

  it('env validation lists what is missing and never echoes values', () => {
    const bad = checkAlertsEnv({ TELEGRAM_BOT_TOKEN: 'nope-secret-value' }, { store: 'blob' });
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(' ')).toMatch(/does not look like a bot token/);
    expect(bad.problems.join(' ')).toMatch(/ALERTS_STORE_KEY is not set/);
    expect(bad.problems.join(' ')).toMatch(/BLOB_READ_WRITE_TOKEN/);
    expect(bad.problems.join(' ')).not.toContain('nope-secret-value');
    const good = checkAlertsEnv({ TELEGRAM_BOT_TOKEN: `123456:${'a'.repeat(35)}`, ALERTS_STORE_KEY: key.toString('base64') }, { store: 'file' });
    expect(good).toEqual({ ok: true, problems: [] });
  });
});

describe('alerts · Telegram adapter (fake HTTP)', () => {
  const TOKEN = `123456:${'S'.repeat(35)}`;
  const fake = (handler: (method: string, body: Record<string, unknown>) => { status: number; body: unknown }) => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const f = async (url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      calls.push({ url, body });
      const r = handler(url.split('/').at(-1)!, body);
      return { status: r.status, json: async () => r.body };
    };
    return { f, calls };
  };

  it('rejects a malformed token up front', () => {
    expect(() => telegramTransport({ token: 'abc' })).toThrow(/not a valid bot token/);
  });

  it('polls private chats only and advances the cursor past everything seen', async () => {
    const { f } = fake(() => ({
      status: 200,
      body: { ok: true, result: [{ update_id: 10, message: { chat: { id: 5, type: 'private' }, text: '/start' } }, { update_id: 11, message: { chat: { id: -9, type: 'group' }, text: '/start' } }] },
    }));
    const t = telegramTransport({ token: TOKEN, fetch: f });
    const r = await t.poll(0);
    expect(r.messages).toEqual([{ updateId: 10, chatId: '5', text: '/start' }]);
    expect(r.next).toBe(12);
  });

  it('send: ok; 429 waits once then retries; 403 = blocked; 5xx = retryable; token never in errors', async () => {
    let n = 0;
    const { f } = fake(() => (n++ === 0 ? { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } } } : { status: 200, body: { ok: true } }));
    const slept: number[] = [];
    expect(await telegramTransport({ token: TOKEN, fetch: f, sleep: async (ms) => void slept.push(ms) }).send('5', 'hi')).toEqual({ ok: true });
    expect(slept).toEqual([1000]);
    const blocked = await telegramTransport({ token: TOKEN, fetch: fake(() => ({ status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } })).f }).send('5', 'x');
    expect(blocked).toMatchObject({ ok: false, blocked: true });
    const down = await telegramTransport({ token: TOKEN, fetch: fake(() => ({ status: 502, body: { ok: false, error_code: 502, description: `Bad Gateway ${TOKEN}` } })).f }).send('5', 'x');
    expect(down).toMatchObject({ ok: false, retryable: true, blocked: false });
    expect(JSON.stringify(down)).not.toContain(TOKEN);
  });
});
