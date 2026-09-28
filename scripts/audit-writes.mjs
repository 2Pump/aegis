// Fails if any write / signing / order path appears in our source.
// Acceptance: "Zero approve() / zero order paths in the repo".
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['apps', 'packages', 'scripts'];
const SKIP = new Set(['audit-writes.mjs', 'node_modules', 'dist', 'test-results', 'playwright-report']);
const BANNED = [
  /\bapprove\s*\(/,
  /['"]approve['"]/,
  /\bwriteContract\b/,
  /\bsendTransaction\b/,
  /\bsignTypedData\b/,
  /\bsignMessage\b/,
  /\/execute\b/,
  /\bplace_order\b/,
  /\bplaceOrder\b/,
  /\btransferFrom\b/,
  /\bpermit\s*\(/,
];

const hits = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    if (SKIP.has(f)) continue;
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|js|mjs)$/.test(f)) {
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        for (const re of BANNED) if (re.test(line)) hits.push(`${relative(root, p)}:${i + 1}  ${line.trim()}`);
      });
    }
  }
};
for (const d of DIRS) walk(join(root, d));

if (hits.length) {
  console.error('WRITE PATHS FOUND:\n' + hits.join('\n'));
  process.exit(1);
}
console.log('audit-writes: 0 write/sign/order paths in apps/ and packages/');
