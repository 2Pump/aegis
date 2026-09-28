import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { classify, type Book, type Pose } from '@aegis/pose';
import { ENV } from './env';
import { log } from './log';
import { loadBook, loadHead } from './sensors';
import type { ChainHead } from '@aegis/ink-io';

export interface HullState {
  book: Book;
  pose: Pose;
  /** ms of the last read where each sensor was OK */
  lastOk: { tydro: number | null; nado: number | null };
  firstSeen: number;
}

/* ───────── session cache of hulls this tab has read (feeds the well) ───────── */
let cache = new Map<string, HullState>();
const subs = new Set<() => void>();
function put(addr: string, s: HullState) {
  cache = new Map(cache).set(addr, s);
  subs.forEach((f) => f());
}
export function useHullCache(): Map<string, HullState> {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => cache,
  );
}

/* ───────── focused hull polling: 15s, backoff on 429, pause while hidden ───────── */
export function useLiveHull(addr: `0x${string}` | null): { state: HullState | null; loading: boolean; nextInMs: number | null; refresh: () => void } {
  const [state, setState] = useState<HullState | null>(addr ? cache.get(addr) ?? null : null);
  const [loading, setLoading] = useState(false);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const delay = useRef<number>(ENV.hullPollMs);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    if (!addr) return;
    let alive = true;
    setState(cache.get(addr) ?? null);
    delay.current = ENV.hullPollMs;

    const tick = async () => {
      if (!alive) return;
      if (typeof document !== 'undefined' && document.hidden) {
        schedule(ENV.hullPollMs);
        return;
      }
      setLoading(true);
      const t0 = performance.now();
      log('info', addr, 'read → Tydro + Nado (both via Ink RPC)');
      const r = await loadBook(addr);
      if (!alive) return;
      const ms = Math.round(performance.now() - t0);
      const b = r.book;
      log(b.tydro.status === 'OK' ? 'ok' : 'err', addr, b.tydro.status === 'OK' ? `TYDRO ok · block ${b.asOfBlock ?? '?'} · hf ${b.tydro.data.hf?.toFixed(3) ?? '∞ (no debt)'} · ${b.tydro.data.supplies.length} supply / ${b.tydro.data.debts.length} debt legs` : `TYDRO DARK · ${b.tydro.code} · ${b.tydro.message}`);
      log(b.nado.status === 'OK' ? 'ok' : 'err', addr, b.nado.status === 'OK' ? `NADO ok · ${b.nado.data.subaccounts.length} subaccount(s) · ${b.nado.data.spots.length} spot / ${b.nado.data.perps.length} perp legs` : `NADO DARK · ${b.nado.code} · ${b.nado.message}`);
      const pose = classify(b);
      log('info', addr, `pose ${pose.tags.join(' + ') || 'NO RULE FIRED'} · hull ${pose.hullTemp} · ${ms}ms`);
      const prev = cache.get(addr);
      const next: HullState = {
        book: b,
        pose,
        lastOk: {
          tydro: b.tydro.status === 'OK' ? b.asOfTime : prev?.lastOk.tydro ?? null,
          nado: b.nado.status === 'OK' ? b.asOfTime : prev?.lastOk.nado ?? null,
        },
        firstSeen: prev?.firstSeen ?? b.asOfTime,
      };
      put(addr, next);
      setState(next);
      setLoading(false);
      if (r.rateLimited) {
        delay.current = Math.min(ENV.maxBackoffMs, Math.max(delay.current * 2, (r.retryAfterS ?? 0) * 1000));
        log('err', addr, `RATE_LIMIT — backing off to ${Math.round(delay.current / 1000)}s`);
      } else delay.current = ENV.hullPollMs;
      schedule(delay.current);
    };
    const schedule = (ms: number) => {
      if (timer.current) clearTimeout(timer.current);
      setNextAt(Date.now() + ms);
      timer.current = setTimeout(() => void tick(), ms);
    };
    kick.current = () => {
      if (timer.current) clearTimeout(timer.current);
      void tick();
    };
    void tick();
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [addr]);

  return { state, loading, nextInMs: nextAt === null ? null : Math.max(0, nextAt - Date.now()), refresh: () => kick.current() };
}

/* ───────── footer: chain head ───────── */
export interface HeadState {
  head: ChainHead | null;
  error: string | null;
}
export function useChainHead(): HeadState {
  const [s, set] = useState<HeadState>({ head: null, error: null });
  useEffect(() => {
    let alive = true;
    const go = async () => {
      const r = await loadHead();
      if (!alive) return;
      if (r.ok) set({ head: r.value, error: null });
      else {
        set((p) => ({ head: p.head, error: `${r.error.code}: ${r.error.message}` }));
        log('err', 'chain', `head ${r.error.code} · ${r.error.message}`);
      }
    };
    void go();
    const id = setInterval(() => void go(), ENV.hullPollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return s;
}

/** 1 Hz clock for "age" labels. */
export function useNow(ms = 1000): number {
  const [n, set] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => set(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}
