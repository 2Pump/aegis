import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { LiveEngine, type CensusShip, type LiveChange, type LiveStats } from '@aegis/census';
import { log } from './log';
import { inkClient } from './sensors';
import type { CensusState } from './census';

export interface LiveWell {
  ships: CensusShip[];
  changes: LiveChange[];
  stats: LiveStats;
  live: boolean;
  setLive: (on: boolean) => void;
  /** addresses updated by the live layer in the last few seconds → flash on the well */
  flashes: Map<string, number>;
}

/**
 * Wraps the census LiveEngine for React. Pauses while the tab is hidden (no reads nobody is watching).
 * All reads go through @aegis/ink-io via the census package.
 */
export function useLiveWell(census: CensusState, enabled = true): LiveWell {
  const engine = useMemo(
    () => new LiveEngine(inkClient, { onLog: (lvl, msg) => log(lvl, 'live', msg) }),
    [],
  );
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [live, setLive] = useState(true);
  const [visible, setVisible] = useState(typeof document === 'undefined' ? true : !document.hidden);
  const flashes = useRef(new Map<string, number>());
  const lastSeenAt = useRef(0);

  // snapshot in
  useEffect(() => {
    if (census.status === 'ok') engine.load(census.ships, census.snap.block);
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
      log('info', 'live', 'live layer started');
    } else if (engine.stats.running) {
      engine.stop();
      log('info', 'live', visible ? 'live layer paused' : 'live layer paused (tab hidden)');
    }
    return () => engine.stop();
  }, [enabled, live, visible, census.status, engine]);

  return {
    ships: [...engine.ships.values()],
    changes: engine.changes,
    stats: engine.stats,
    live,
    setLive,
    flashes: flashes.current,
  };
}
