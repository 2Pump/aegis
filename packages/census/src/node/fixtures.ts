import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * AEGIS's synthetic test wallets (every address in /fixtures). They are never real accounts: the census history
 * and the alerts both refuse them. A missing folder gives an empty set (then nothing extra is excluded).
 */
export function fixtureAddresses(repoRoot: string): Set<string> {
  const out = new Set<string>();
  const dir = join(repoRoot, 'fixtures');
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/0x[0-9a-fA-F]{40}\b/g)) out.add(m[0].toLowerCase());
  }
  return out;
}
