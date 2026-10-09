/**
 * Who is signed in — from GET /api/v1/auth/me. When accounts aren't switched on (or the function doesn't exist, as on
 * a local build) this says configured:false and the site shows no sign-in at all.
 * Never stores anything in the browser: the session is an HttpOnly cookie the page can't read.
 */
import { useEffect, useState } from 'react';

export type Access = 'free' | 'pro' | 'desk';
export interface Me {
  configured: boolean;
  signedIn: boolean;
  access: Access;
  email?: string;
  plan?: 'pro' | 'desk' | null;
  paidUntil?: string | null;
  since?: string;
}
export type MeState = { status: 'loading' } | { status: 'ok'; me: Me };

const OFF: Me = { configured: false, signedIn: false, access: 'free' };
let current: MeState = { status: 'loading' };
let inflight: Promise<void> | null = null;
const subs = new Set<(s: MeState) => void>();
const emit = (s: MeState) => {
  current = s;
  for (const f of subs) f(s);
};

export function refreshMe(): Promise<void> {
  inflight ??= fetch('/api/v1/auth/me', { credentials: 'same-origin', cache: 'no-store' })
    .then(async (r) => {
      const ct = r.headers.get('content-type') ?? '';
      // a local build answers the SPA's HTML here: accounts simply aren't there
      emit({ status: 'ok', me: r.ok && ct.includes('json') ? ((await r.json()) as Me) : OFF });
    })
    .catch(() => emit({ status: 'ok', me: OFF }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useMe(): MeState {
  const [s, set] = useState<MeState>(current);
  useEffect(() => {
    subs.add(set);
    if (current.status === 'loading') void refreshMe();
    else set(current);
    return () => {
      subs.delete(set);
    };
  }, []);
  return s;
}

export async function authPost<T>(path: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  try {
    const r = await fetch(`/api/v1/auth/${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
    if (!r.ok) return { ok: false, status: r.status, message: j?.error?.message ?? `Something went wrong (HTTP ${r.status}).` };
    return { ok: true, data: j as T };
  } catch {
    return { ok: false, status: 0, message: "Couldn't reach Phrourax — check your connection and try again." };
  }
}

export const PLAN_LABEL: Record<Access, string> = { free: 'Free', pro: 'Pro', desk: 'Desk' };
export const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
