import { useSyncExternalStore } from 'react';
import { parseAddress } from '@aegis/ink-io';

/*
 * "My wallet" without a wallet connection. Phrourax is read-only: it never asks a wallet extension for anything, so
 * there is no connect prompt and nothing for a wallet's phishing check to trip on. You open any wallet page and
 * press "Set as my wallet"; the address is remembered in this browser only (never sent anywhere), and the header
 * gets a "My wallet" shortcut.
 */

const KEY = 'aegis-my-wallet';
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    const v = localStorage.getItem(KEY);
    if (!v) return null;
    const p = parseAddress(v);
    return p.ok ? p.value.lower : null;
  } catch {
    return null; // storage blocked (private mode): the feature just stays off
  }
}

let current = typeof window === 'undefined' ? null : read();

export function setMyWallet(address: string | null): void {
  try {
    if (address) localStorage.setItem(KEY, address.toLowerCase());
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: remember for this tab only */
  }
  current = address ? address.toLowerCase() : null;
  listeners.forEach((f) => f());
}

export function useMyWallet(): string | null {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      const onStorage = (e: StorageEvent) => {
        if (e.key === KEY) {
          current = read();
          f();
        }
      };
      window.addEventListener('storage', onStorage); // another tab changed it
      return () => {
        listeners.delete(f);
        window.removeEventListener('storage', onStorage);
      };
    },
    () => current,
    () => null,
  );
}
