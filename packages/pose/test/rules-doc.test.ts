import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RULES } from '../src/index.js';

/**
 * /docs/RULES.md must carry a constants table whose values equal src/config.ts.
 * Row format: | `NAME` | value | … |
 */
describe('docs/RULES.md matches code constants', () => {
  const md = readFileSync(fileURLToPath(new URL('../../../docs/RULES.md', import.meta.url)), 'utf8');
  const rows = new Map<string, string>();
  for (const m of md.matchAll(/^\|\s*`([A-Z_]+)`\s*\|\s*([^|]+?)\s*\|/gm)) rows.set(m[1]!, m[2]!);

  for (const [k, v] of Object.entries(RULES)) {
    it(`${k} = ${String(v)}`, () => {
      expect(rows.has(k), `RULES.md is missing a row for ${k}`).toBe(true);
      expect(rows.get(k)).toBe(String(v));
    });
  }
});
