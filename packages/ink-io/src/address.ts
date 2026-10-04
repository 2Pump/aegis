import { getAddress, isAddress } from 'viem';
import { Err, Ok, type Result } from './result.js';

export interface ParsedAddress {
  /** lowercase — how we store and key */
  lower: `0x${string}`;
  /** EIP-55 checksum — how we display */
  checksum: `0x${string}`;
}

/** Accepts any-case 0x address. Rejects a mixed-case string whose checksum is wrong. */
export function parseAddress(input: string): Result<ParsedAddress> {
  const s = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return Err('PARSE_FAIL', 'Not a 0x address (40 hex chars).');
  const isMixed = s !== s.toLowerCase() && s !== s.slice(0, 2) + s.slice(2).toUpperCase();
  if (isMixed && !isAddress(s, { strict: true })) return Err('PARSE_FAIL', 'Checksum does not match. Re-copy the address.');
  const checksum = getAddress(s.toLowerCase());
  return Ok({ lower: s.toLowerCase() as `0x${string}`, checksum });
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Nado subaccount bytes32 = 20-byte address ‖ 12-byte name (ASCII, right-padded with 0x00). */
export function nadoSubaccount(address: string, name = 'default'): `0x${string}` {
  const bytes = new TextEncoder().encode(name);
  if (bytes.length > 12) throw new Error('subaccount name > 12 bytes');
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `${address.toLowerCase()}${hex.padEnd(24, '0')}` as `0x${string}`;
}

/** default | isolated (engine-created, name contains "iso") | other — from the subaccount's 12-byte name */
export function subaccountKind(sub: string): 'default' | 'isolated' | 'other' {
  const tail = sub.slice(42).toLowerCase();
  if (tail === nadoSubaccount('0x0000000000000000000000000000000000000000').slice(42)) return 'default';
  return tail.includes('69736f') ? 'isolated' : 'other';
}
