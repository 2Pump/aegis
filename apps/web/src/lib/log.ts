import { useSyncExternalStore } from 'react';

/** On-page sensor log. Visible in the UI so a screenshot carries the diagnosis — no devtools needed. */
export type LogLevel = 'ok' | 'err' | 'info';
export interface LogEntry {
  at: number;
  level: LogLevel;
  scope: string;
  msg: string;
}

const MAX = 200;
let entries: LogEntry[] = [];
const subs = new Set<() => void>();

export function log(level: LogLevel, scope: string, msg: string): void {
  entries = [{ at: Date.now(), level, scope, msg }, ...entries].slice(0, MAX);
  subs.forEach((f) => f());
}

export function useLog(scope?: string): LogEntry[] {
  const all = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => entries,
  );
  return scope ? all.filter((e) => e.scope === scope || e.scope === 'chain') : all;
}
