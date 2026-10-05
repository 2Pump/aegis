// Fails if any write / signing / order path appears in our source.
// Acceptance: "Zero approve() / zero order paths in the repo".
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['apps', 'packages', 'scripts'];
const SKIP = new Set(['audit-writes.mjs', 'node_modules', 'dist', 'test-results', 'playwright-report']);
// Generated bundles: like dist/, built only from the sources audited here plus library code (viem's ABI constants
// contain the words "approve"/"transferFrom"). `pnpm --filter @aegis/web check:api` proves the bundle matches its sources.
const SKIP_PATHS = new Set([join('apps', 'web', 'api', 'v1.js')]);
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
  // no wallet connection at all (2026-09-30): a connect prompt is what wallet phishing checks score
  /\beth_requestAccounts\b/,
  /\.ethereum\.request\b/,
  /from\s+['"](wagmi|@wagmi\/|ethers|@web3-onboard\/|@rainbow-me\/|@reown\/|@walletconnect\/)/,
];

const hits = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    if (SKIP.has(f)) continue;
    const p = join(d, f);
    if (SKIP_PATHS.has(relative(root, p))) continue;
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
console.log('audit-writes: 0 write/sign/order/wallet-connect paths in apps/ and packages/');
