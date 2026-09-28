import { useSyncExternalStore } from 'react';

/** Addresses this browser tab has looked at. sessionStorage only — never sent anywhere. */
const KEY = 'aegis.recent.v1';
const MAX = 24;

function load(): string[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && /^0x[0-9a-f]{40}$/.test(x)) : [];
  } catch {
    return [];
  }
}

let list: string[] = load();
const subs = new Set<() => void>();

export function remember(addrLower: string): void {
  if (list[0] === addrLower) return;
  list = [addrLower, ...list.filter((a) => a !== addrLower)].slice(0, MAX);
  try {
    sessionStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private mode: memory only */
  }
  subs.forEach((f) => f());
}

export function useRecent(): string[] {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => list,
  );
}
