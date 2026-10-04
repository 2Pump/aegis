import status from '../../../../verification/status.json';

/**
 * Gate: the well is fully verified only when `pnpm prove <address>` has matched real Ink addresses against the
 * official UIs for BOTH venues. Each venue can be proven on its own (e.g. Tydro with a watch-only address in a
 * read-only wallet); the site then says exactly which one is verified. Read at build time from verification/status.json.
 */
export type Venue = 'tydro' | 'nado';

export interface Proof {
  address: string;
  at: string;
  block: number | null;
  fields: number;
  rulesVersion: string;
  /** venues this proof covered (older proofs: both) */
  venues?: Venue[];
  /** what each venue was matched against: the official app ('ui') or Nado's official API ('api') */
  sources?: Partial<Record<Venue, 'ui' | 'api'>>;
}

interface StatusFile {
  verified: boolean;
  venues?: Partial<Record<Venue, boolean>>;
  proofs?: Proof[];
}
const s = status as StatusFile;

export const PROOFS: Proof[] = s.proofs ?? [];
export const VENUE_VERIFIED: Record<Venue, boolean> = {
  tydro: s.venues?.tydro === true || s.verified === true,
  nado: s.venues?.nado === true || s.verified === true,
};
/** both venues proven → the well is no longer a preview */
export const VERIFIED: boolean = VENUE_VERIFIED.tydro && VENUE_VERIFIED.nado;

const VENUE_UI: Record<Venue, string> = { tydro: 'app.tydro.com', nado: 'app.nado.xyz' };

export function proofFor(v: Venue): Proof | undefined {
  return [...PROOFS].reverse().find((p) => (p.venues ?? ['tydro', 'nado']).includes(v));
}

/** One line for banners: which venue is verified, against what, and which is still pending. */
export function verificationText(): string {
  const parts = (['tydro', 'nado'] as const).map((v) => {
    const p = proofFor(v);
    const name = v === 'tydro' ? 'Tydro' : 'Nado';
    const against = p?.sources?.[v] === 'api' ? `${name}'s official API` : VENUE_UI[v];
    return VENUE_VERIFIED[v] && p
      ? `${name} verified against ${against} (${p.address}, block ${p.block?.toLocaleString('en-US') ?? '—'})`
      : `${name} not yet matched against ${VENUE_UI[v]}`;
  });
  return parts.join(' · ');
}

/** A check older than this is shown as STALE on the Checks page (the venues and the rules move on). */
export const PROOF_STALE_DAYS = 30;

export function proofAgeDays(p: Proof, nowMs = Date.now()): number | null {
  const t = Date.parse(p.at);
  return Number.isFinite(t) ? (nowMs - t) / 86_400_000 : null;
}

/** How a stored check is shown: under the rules it RAN with, flagged when older than today's rules or stale. */
export function proofStatus(p: Proof, currentRules: string, nowMs = Date.now()): { ranUnder: string; olderRules: boolean; ageDays: number | null; stale: boolean } {
  const ageDays = proofAgeDays(p, nowMs);
  return { ranUnder: p.rulesVersion, olderRules: p.rulesVersion !== currentRules, ageDays, stale: ageDays === null || ageDays > PROOF_STALE_DAYS };
}
