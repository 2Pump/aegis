import {
  decodeNadoSubaccounts,
  decodeTydroTransfers,
  nadoSubaccount,
  readBooksMany,
  scanNadoActivity,
  scanTydro,
  subaccountOwner,
} from '@aegis/ink-io';
import { classify, type HullTemp, type Tag } from '@aegis/pose';
import type { PublicClient } from 'viem';
import { shipFromRead, type CensusShip } from './index.js';

/**
 * The live layer. Starts from the hourly snapshot and keeps it current from the chain:
 *  - every tick (~4 s): "what changed since the last block?" (Tydro token transfers + Nado activity events)
 *    → wallets that did something are re-read exactly, within seconds
 *  - every ~15 s: the next few at-risk ships are re-read, because price alone can hurt them
 * Every update is a real chain read. Nothing is estimated between reads.
 */
export interface LiveStats {
  running: boolean;
  head: number | null;
  cursor: number | null;
  lagBlocks: number | null;
  logsSeen: number;
  touched: number;
  reads: number;
  queue: number;
  errors: number;
  lastError: string | null;
  /** true when we had to skip blocks to catch up (snapshot older than the catch-up cap) */
  gap: boolean;
}

export interface LiveChange {
  at: number;
  address: string;
  kind: 'new' | 'flip' | 'temp' | 'wounded' | 'healed';
  from: { primary: Tag | null; hullTemp: HullTemp } | null;
  to: { primary: Tag | null; hullTemp: HullTemp };
}

export interface LiveOpts {
  tickMs?: number;
  /** re-read this many at-risk ships every watchEvery ticks */
  watchBatch?: number;
  watchEvery?: number;
  /** max wallets re-read per tick */
  readsPerTick?: number;
  /** don't scan more than this many blocks per tick (catch-up spreads over ticks) */
  maxBlocksPerTick?: number;
  /** if further behind than this, skip ahead and flag a gap */
  maxCatchUp?: number;
  now?: () => number;
  onLog?: (level: 'ok' | 'err' | 'info', msg: string) => void;
}

export class LiveEngine {
  readonly ships = new Map<string, CensusShip>();
  readonly changes: LiveChange[] = [];
  readonly stats: LiveStats = { running: false, head: null, cursor: null, lagBlocks: null, logsSeen: 0, touched: 0, reads: 0, queue: 0, errors: 0, lastError: null, gap: false };
  private queue: string[] = [];
  private queued = new Set<string>();
  private liveSubs = new Map<string, Set<string>>();
  private watchCursor = 0;
  private tickN = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private listeners = new Set<() => void>();
  private o: Required<Omit<LiveOpts, 'onLog'>> & Pick<LiveOpts, 'onLog'>;

  constructor(private client: PublicClient, opts: LiveOpts = {}) {
    this.o = {
      tickMs: opts.tickMs ?? 4000,
      watchBatch: opts.watchBatch ?? 8,
      watchEvery: opts.watchEvery ?? 4,
      readsPerTick: opts.readsPerTick ?? 12,
      maxBlocksPerTick: opts.maxBlocksPerTick ?? 1000,
      maxCatchUp: opts.maxCatchUp ?? 5000,
      now: opts.now ?? (() => Date.now()),
      onLog: opts.onLog,
    };
  }

  subscribe(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }
  private emit() {
    this.stats.queue = this.queue.length;
    this.listeners.forEach((f) => f());
  }

  /** Load (or refresh from) a snapshot. Live readings newer than the snapshot are kept. */
  load(ships: readonly CensusShip[], snapshotBlock: number) {
    for (const s of ships) {
      const cur = this.ships.get(s.address);
      if (!cur || s.readBlock >= cur.readBlock) this.ships.set(s.address, s);
    }
    if (this.stats.cursor === null || this.stats.cursor < snapshotBlock) this.stats.cursor = snapshotBlock;
    this.emit();
  }

  start() {
    if (this.stats.running) return;
    this.stats.running = true;
    this.emit();
    const loop = async () => {
      if (!this.stats.running) return;
      await this.tick();
      if (this.stats.running) this.timer = setTimeout(() => void loop(), this.o.tickMs);
    };
    void loop();
  }

  stop() {
    this.stats.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.emit();
  }

  private enqueue(addr: string, front: boolean) {
    const a = addr.toLowerCase();
    if (this.queued.has(a)) return;
    this.queued.add(a);
    if (front) this.queue.unshift(a);
    else this.queue.push(a);
  }

  /** One cycle. Public for tests. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const log = this.o.onLog ?? (() => {});
    try {
      const head = Number(await this.client.getBlockNumber());
      this.stats.head = head;
      if (this.stats.cursor === null) this.stats.cursor = head - 1;
      if (head - this.stats.cursor > this.o.maxCatchUp) {
        log('err', `live: ${head - this.stats.cursor} blocks behind — skipping to the last ${this.o.maxCatchUp}`);
        this.stats.cursor = head - this.o.maxCatchUp;
        this.stats.gap = true;
      }
      const from = this.stats.cursor + 1;
      const to = Math.min(head, this.stats.cursor + this.o.maxBlocksPerTick);
      if (from <= to) {
        const [t, n] = await Promise.all([
          scanTydro(this.client, from, to, { initialSpan: to - from + 1, maxSpan: this.o.maxBlocksPerTick }),
          scanNadoActivity(this.client, from, to, { initialSpan: to - from + 1, maxSpan: this.o.maxBlocksPerTick }),
        ]);
        this.stats.logsSeen += t.logs.length + n.logs.length;
        const touched = new Set<string>(decodeTydroTransfers(t.logs).keys());
        for (const sub of decodeNadoSubaccounts(n.logs)) {
          const owner = subaccountOwner(sub);
          touched.add(owner);
          if (sub !== nadoSubaccount(owner)) {
            const set = this.liveSubs.get(owner) ?? new Set<string>();
            set.add(sub);
            this.liveSubs.set(owner, set);
          }
        }
        this.stats.touched += touched.size;
        touched.forEach((a) => this.enqueue(a, true));
        this.stats.cursor = Math.min(t.scannedTo, n.scannedTo);
        if (touched.size) log('info', `blocks ${from}→${this.stats.cursor}: ${t.logs.length + n.logs.length} events, ${touched.size} wallets touched`);
      }
      this.stats.lagBlocks = head - (this.stats.cursor ?? head);

      // at-risk round-robin
      this.tickN++;
      if (this.tickN % this.o.watchEvery === 0) {
        const watch = [...this.ships.values()].filter((s) => s.watch || s.hullTemp === 'CRITICAL' || s.hullTemp === 'ELEVATED');
        for (let k = 0; k < Math.min(this.o.watchBatch, watch.length); k++) {
          this.enqueue(watch[(this.watchCursor + k) % watch.length]!.address, false);
        }
        this.watchCursor = watch.length ? (this.watchCursor + this.o.watchBatch) % watch.length : 0;
      }

      // re-read
      const batch = this.queue.splice(0, this.o.readsPerTick);
      batch.forEach((a) => this.queued.delete(a));
      if (batch.length) {
        const subs = new Map(
          batch.map((a) => [a, [...new Set([...(this.ships.get(a)?.extraSubs ?? []), ...(this.liveSubs.get(a) ?? [])])] as `0x${string}`[]] as const),
        );
        const res = await readBooksMany(this.client, { addresses: batch, nadoSubs: subs, blockNumber: BigInt(head) });
        for (const [a, book] of res.books) {
          const pose = classify(book);
          const prev = this.ships.get(a);
          if (pose.primary === 'DARK' && prev && prev.primary !== 'DARK') {
            this.stats.errors++;
            this.stats.lastError = `${a.slice(0, 8)}…: sensor dark on live re-read — kept previous reading`;
            continue;
          }
          if (pose.primary === 'EMPTY' && !prev) continue; // an empty wallet we never drew
          const extra = (subs.get(a) ?? []).filter((s) => res.activeSubs.has(s));
          const next = shipFromRead(book, pose, prev, extra);
          this.ships.set(a, next);
          this.stats.reads++;
          const change = diff(prev, next, this.o.now());
          if (change) {
            this.changes.unshift(change);
            if (this.changes.length > 50) this.changes.length = 50;
            log('ok', `${a.slice(0, 6)}…${a.slice(-4)} ${change.kind}: ${change.from ? `${change.from.primary ?? '—'}/${change.from.hullTemp} → ` : ''}${next.primary ?? '—'}/${next.hullTemp}`);
          }
        }
      }
    } catch (e) {
      this.stats.errors++;
      const raw = e instanceof Error ? e.message.split('\n')[0]! : String(e);
      this.stats.lastError = /rpc|http|fetch|network/i.test(raw) ? `Ink RPC: ${raw}` : raw;
      log('err', `live tick failed: ${this.stats.lastError}`);
    } finally {
      this.busy = false;
      this.emit();
    }
  }
}

function diff(prev: CensusShip | undefined, next: CensusShip, at: number): LiveChange | null {
  const to = { primary: next.primary, hullTemp: next.hullTemp };
  if (!prev) return { at, address: next.address, kind: 'new', from: null, to };
  const from = { primary: prev.primary, hullTemp: prev.hullTemp };
  const wasW = prev.tags.includes('WOUNDED');
  const isW = next.tags.includes('WOUNDED');
  if (!wasW && isW) return { at, address: next.address, kind: 'wounded', from, to };
  if (wasW && !isW) return { at, address: next.address, kind: 'healed', from, to };
  if (prev.primary !== next.primary) return { at, address: next.address, kind: 'flip', from, to };
  if (prev.hullTemp !== next.hullTemp) return { at, address: next.address, kind: 'temp', from, to };
  return null;
}
