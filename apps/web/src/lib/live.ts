import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { LiveEngine, type CensusShip, type LiveChange, type LiveStats } from '@aegis/census';
import { RISK_LABEL, TAG_LABEL, NO_TYPE_LABEL } from '@aegis/glyphs';
import type { HullTemp, Tag } from '@aegis/pose';
import { log } from './log';
import { inkClient } from './sensors';
import type { CensusState } from './census';

export interface LiveWell {
  ships: CensusShip[];
  /** the engine's newest reading of one wallet (fresher than `ships` after a re-read that changed nothing) */
  latest(address: string): CensusShip | undefined;
  changes: LiveChange[];
  stats: LiveStats;
  live: boolean;
  setLive: (on: boolean) => void;
  /** addresses updated by the live layer in the last few seconds → flash on the well */
  flashes: Map<string, number>;
  /** the tab is visible (a hidden tab pauses live reads) */
  visible: boolean;
  /**
   * the live layer has taken in a scan (its wallets are in `ships`). False only before the FIRST scan is loaded —
   * a refresh to a newer scan never flips it back, so a page never blanks during a background refresh.
   */
  seeded: boolean;
}

/**
 * Wraps the census LiveEngine for React. Pauses while the tab is hidden (no reads nobody is watching).
 * All reads go through @aegis/ink-io via the census package.
 */
export function useLiveWell(census: CensusState, enabled = true): LiveWell {
  const engine = useMemo(
    () => new LiveEngine(inkClient, { onLog: (lvl, msg) => log(lvl, 'live', plainLive(msg)) }),
    [],
  );
  const [, bump] = useReducer((x: number) => x + 1, 0);
  // a new array only when the engine says the drawn picture changed — re-reads that change nothing keep it stable
  const version = engine.shipsVersion;
  const ships = useMemo(() => [...engine.ships.values()], [engine, version]);
  const [live, setLive] = useState(true);
  const [visible, setVisible] = useState(typeof document === 'undefined' ? true : !document.hidden);
  const flashes = useRef(new Map<string, number>());
  const lastSeenAt = useRef(0);

  // snapshot in — and re-render at once (not on the throttled tick), so counts never show the empty pre-load list
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (census.status !== 'ok') return;
    engine.load(census.ships, census.snap.block);
    setSeeded(true);
    bump();
  }, [census, engine]);

  // re-render on engine updates (throttled to ~2/s), record flashes
  useEffect(() => {
    let pending = false;
    return engine.subscribe(() => {
      // changes are newest-first; flash everything newer than what we've already seen
      for (const c of engine.changes) {
        if (c.at <= lastSeenAt.current) break;
        flashes.current.set(c.address, c.at);
      }
      if (engine.changes[0]) lastSeenAt.current = Math.max(lastSeenAt.current, engine.changes[0].at);
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        bump();
      }, 500);
    });
  }, [engine]);

  // visibility
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  // run only when wanted, visible, and a snapshot (or at least a cursor) exists
  useEffect(() => {
    const ready = census.status === 'ok' || census.status === 'missing';
    if (enabled && live && visible && ready) {
      engine.start();
      log('info', 'live', 'live updates started');
    } else if (engine.stats.running) {
      engine.stop();
      log('info', 'live', visible ? 'live updates paused' : 'live updates paused (tab hidden)');
    }
    return () => engine.stop();
  }, [enabled, live, visible, census.status, engine]);

  return {
    ships,
    latest: (address: string) => engine.ships.get(address),
    changes: engine.changes,
    stats: engine.stats,
    live,
    setLive,
    flashes: flashes.current,
    visible,
    seeded,
  };
}

/** "CARRY/NOMINAL → NAKED/CRITICAL" in engine log lines → plain names ("Hedged, Safe → Unhedged bet, Near liquidation"). */
export function plainLive(msg: string): string {
  return msg.replace(/([A-Z][A-Z-]*|—)\/(NOMINAL|ELEVATED|CRITICAL|UNKNOWN)/g, (_, t: string, h: HullTemp) => {
    const type = t === '—' ? NO_TYPE_LABEL : ((TAG_LABEL as Record<string, string>)[t as Tag] ?? t);
    return `${type}, ${RISK_LABEL[h]}`;
  }).replace(/ (new|flip|temp|wounded|healed):/, (_, k: string) => ` ${({ new: 'new wallet', flip: 'type changed', temp: 'risk changed', wounded: 'now near liquidation', healed: 'recovered' } as Record<string, string>)[k] ?? k}:`);
}
