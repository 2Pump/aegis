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
    return VENUE_VERIFIED[v] && p
      ? `${name} verified against ${VENUE_UI[v]} (${p.address}, block ${p.block?.toLocaleString('en-US') ?? '—'})`
      : `${name} not yet matched against ${VENUE_UI[v]}`;
  });
  return parts.join(' · ');
}
