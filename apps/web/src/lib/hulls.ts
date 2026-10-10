import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { classify, type Book, type Pose } from '@aegis/pose';
import { NO_TYPE_LABEL, RISK_LABEL, TAG_LABEL } from '@aegis/glyphs';
import { ENV } from './env';
import { log } from './log';
import { loadBook, loadHead } from './sensors';
import type { ChainHead, ReadStage } from '@aegis/ink-io';

/** What a read in progress is actually doing, per venue (from readBook's own callbacks — never a timed animation). */
export interface ReadProgress {
  startedAt: number;
  tydro: ReadStage['phase'] | 'waiting';
  nado: ReadStage['phase'] | 'waiting';
}

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
export function useLiveHull(addr: `0x${string}` | null): { state: HullState | null; loading: boolean; progress: ReadProgress | null; nextInMs: number | null; refresh: () => void } {
  const [state, setState] = useState<HullState | null>(addr ? cache.get(addr) ?? null : null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ReadProgress | null>(null);
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
      setProgress({ startedAt: Date.now(), tydro: 'waiting', nado: 'waiting' });
      const r = await loadBook(addr, (st) => alive && setProgress((p) => (p ? { ...p, [st.venue]: st.phase } : p)));
      if (!alive) return;
      setProgress(null);
      const ms = Math.round(performance.now() - t0);
      const b = r.book;
      log(b.tydro.status === 'OK' ? 'ok' : 'err', addr, b.tydro.status === 'OK' ? `TYDRO ok · block ${b.asOfBlock ?? '?'} · hf ${b.tydro.data.hf?.toFixed(3) ?? '∞ (no debt)'} · ${b.tydro.data.supplies.length} supply / ${b.tydro.data.debts.length} debt legs` : `TYDRO COULDN'T READ · ${b.tydro.code} · ${b.tydro.message}`);
      log(b.nado.status === 'OK' ? 'ok' : 'err', addr, b.nado.status === 'OK' ? `NADO ok · ${b.nado.data.subaccounts.length} subaccount(s) · ${b.nado.data.spots.length} spot / ${b.nado.data.perps.length} perp legs` : `NADO COULDN'T READ · ${b.nado.code} · ${b.nado.message}`);
      const pose = classify(b);
      log('info', addr, `type ${pose.tags.map((t) => TAG_LABEL[t]).join(' + ') || NO_TYPE_LABEL} · risk ${RISK_LABEL[pose.hullTemp]} · ${ms}ms`);
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

  return { state, loading, progress, nextInMs: nextAt === null ? null : Math.max(0, nextAt - Date.now()), refresh: () => kick.current() };
}

/* ───────── footer: chain head ───────── */
export interface HeadState {
  head: ChainHead | null;
  error: string | null;
}
let headState: HeadState = { head: null, error: null };
const headSubs = new Set<() => void>();
let headTimer: ReturnType<typeof setInterval> | null = null;
async function pollHead() {
  const r = await loadHead();
  headState = r.ok ? { head: r.value, error: null } : { head: headState.head, error: `${r.error.code}: ${r.error.message}` };
  if (!r.ok) log('err', 'chain', `head ${r.error.code} · ${r.error.message}`);
  headSubs.forEach((f) => f());
}
// stable subscribe (a new function each render would make React resubscribe — and re-poll — on every render)
function subscribeHead(f: () => void): () => void {
  headSubs.add(f);
  if (!headTimer) {
    void pollHead();
    headTimer = setInterval(() => void pollHead(), ENV.hullPollMs);
  }
  return () => {
    headSubs.delete(f);
    // stop only when nobody has listened for a moment (a remount re-subscribes immediately)
    setTimeout(() => {
      if (!headSubs.size && headTimer) {
        clearInterval(headTimer);
        headTimer = null;
      }
    }, 1000);
  };
}
const headSnapshot = () => headState;
/** The chain head — one shared poll however many parts of the page show it (footer, public evidence). */
export function useChainHead(): HeadState {
  return useSyncExternalStore(subscribeHead, headSnapshot);
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
