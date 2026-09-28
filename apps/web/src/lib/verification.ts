import status from '../../../../verification/status.json';

/**
 * Gate: the well is not drawn until `pnpm prove <address>` has matched one real Ink address
 * against the official Tydro/Nado UIs. Read at build time from verification/status.json.
 */
export interface Proof {
  address: string;
  at: string;
  block: number | null;
  fields: number;
  rulesVersion: string;
}
export const VERIFIED: boolean = (status as { verified: boolean }).verified === true;
export const PROOFS: Proof[] = ((status as { proofs?: Proof[] }).proofs ?? []) as Proof[];
