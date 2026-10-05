/**
 * AEGIS — Vercel Firewall rate limits for the public API (/api/v1). Run once; safe to run again.
 *
 *   $env:VERCEL_TOKEN="…"; pnpm firewall              # create/update the rules, show the diff, publish
 *   $env:VERCEL_TOKEN="…"; pnpm firewall --dry-run    # create/update, show the diff, then DISCARD (nothing goes live)
 *   options: --project <name> (default aegis-web) · --scope <team-slug> (if the project belongs to a team)
 *
 * Why a script: `vercel.json` firewall routes can only deny/challenge (not rate-limit) and can't be mixed with the
 * site's rewrites, and PowerShell 5.1 mangles the JSON arguments the CLI needs. This runs the official Vercel CLI
 * (pinned version, downloaded to a temp folder) with arguments passed directly — no shell, no quoting problems.
 *
 * The rules are written so they never overlap, so their order doesn't matter:
 *   1. live wallet scenario   /api/v1/wallets/…/scenario   15 per IP per minute (the API itself allows 6 per instance)
 *   2. webhook management     /api/v1/webhooks…            30 per IP per minute (API: 20 per instance)
 *   3. everything else        /api/v1…                     300 per IP per minute (API: 120 per instance; edge cache 60 s)
 * Over the limit → HTTP 429 at Vercel's edge, before the function runs. The site itself is not touched.
 * The token is never printed or stored. Use a short-lived token (vercel.com/account/tokens) and delete it after.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_VERSION = '62.4.0';
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const DRY = args.includes('--dry-run');
const PROJECT = opt('--project', 'aegis-web');
const SCOPE = opt('--scope', process.env.VERCEL_SCOPE || '');
const TOKEN = (process.env.VERCEL_TOKEN || '').trim();

const C = (type, op, value, neg = false) => JSON.stringify({ type, op, value, ...(neg ? { neg: true } : {}) });
const RULES = [
  {
    name: 'AEGIS API - live wallet scenario',
    description: 'Rate limit the one live endpoint (/api/v1/wallets/{address}/scenario): 15 per IP per minute → 429',
    conditions: [C('raw_path', 'pre', '/api/v1/wallets/'), C('raw_path', 'sub', '/scenario')],
    window: 60,
    requests: 15,
  },
  {
    name: 'AEGIS API - webhook management',
    description: 'Rate limit /api/v1/webhooks: 30 per IP per minute → 429',
    conditions: [C('raw_path', 'pre', '/api/v1/webhooks')],
    window: 60,
    requests: 30,
  },
  {
    name: 'AEGIS API - read endpoints',
    description: 'Rate limit the rest of /api/v1: 300 per IP per minute → 429 (excludes the two rules above)',
    conditions: [C('raw_path', 'pre', '/api/v1'), C('raw_path', 'sub', '/scenario', true), C('raw_path', 'pre', '/api/v1/webhooks', true)],
    window: 60,
    requests: 300,
  },
];

function fail(msg) {
  console.error(`firewall: ${msg}`);
  process.exit(1);
}
if (!TOKEN) fail('set VERCEL_TOKEN first (vercel.com/account/tokens → Create, scope: the team that owns the project, short expiry). Nothing was changed.');

// 1 ── the official CLI, pinned, in a temp folder (installed once)
const dir = join(tmpdir(), `aegis-vercel-cli-${CLI_VERSION}`);
const pkg = join(dir, 'node_modules', 'vercel', 'package.json');
if (!existsSync(pkg)) {
  console.log(`firewall: downloading Vercel CLI ${CLI_VERSION} (once) …`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['install', '--prefix', dir, '--no-save', '--no-audit', '--no-fund', `vercel@${CLI_VERSION}`], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0 || !existsSync(pkg)) fail('could not download the Vercel CLI (npm install failed). Nothing was changed.');
}
const bin = JSON.parse(readFileSync(pkg, 'utf8')).bin;
const entry = join(dir, 'node_modules', 'vercel', typeof bin === 'string' ? bin : bin.vercel);

const global = ['--token', TOKEN, '--non-interactive', '--no-color', ...(SCOPE ? ['--scope', SCOPE] : [])];
function vc(sub, { json = false, quiet = false } = {}) {
  const r = spawnSync(process.execPath, [entry, ...sub, '--project', PROJECT, ...global], { encoding: 'utf8', env: { ...process.env, VERCEL_TELEMETRY_DISABLED: '1' } });
  const out = `${r.stdout ?? ''}`;
  const err = `${r.stderr ?? ''}`.split(TOKEN).join('<token>');
  if (r.status !== 0) {
    console.error(err.trim() || out.trim());
    fail(`\`vercel ${sub.slice(0, 3).join(' ')}\` failed (exit ${r.status}).${/project/i.test(err) && /not found|could not find/i.test(err) ? ` Is the project called "${PROJECT}"? Pass --project <name>${SCOPE ? '' : ', and --scope <team-slug> if it belongs to a team'}.` : ''}`);
  }
  if (!quiet && !json) process.stdout.write(out);
  return json ? out : out;
}

// 2 ── what exists already (so re-running updates instead of duplicating)
const listed = (() => {
  const raw = vc(['firewall', 'rules', 'list', '--json'], { json: true });
  try {
    const j = JSON.parse(raw.slice(raw.indexOf('{')));
    return new Set((Array.isArray(j.rules) ? j.rules : []).map((r) => r?.name).filter(Boolean));
  } catch {
    fail('could not read the existing rules (unexpected `rules list --json` output). Nothing was changed.');
  }
})();

// 3 ── stage each rule (add or edit)
for (const r of RULES) {
  const flags = [
    ...r.conditions.flatMap((c) => ['--condition', c]),
    '--action', 'rate_limit',
    '--rate-limit-window', String(r.window),
    '--rate-limit-requests', String(r.requests),
    '--rate-limit-keys', 'ip',
    '--rate-limit-algo', 'fixed_window',
    '--rate-limit-action', 'rate_limit',
    '--description', r.description,
    '--yes',
  ];
  const exists = listed.has(r.name);
  console.log(`firewall: ${exists ? 'updating' : 'adding'} "${r.name}" (${r.requests} per IP per ${r.window}s → 429)`);
  vc(exists ? ['firewall', 'rules', 'edit', r.name, ...flags, '--enabled'] : ['firewall', 'rules', 'add', r.name, ...flags], { quiet: true });
}

// 4 ── review, then publish (or discard on a dry run)
console.log('\nfirewall: staged changes —');
vc(['firewall', 'diff']);
if (DRY) {
  vc(['firewall', 'discard', '--yes'], { quiet: true });
  console.log('\nfirewall: DRY RUN — the staged changes were discarded. Nothing went live.');
} else {
  vc(['firewall', 'publish', '--yes'], { quiet: true });
  console.log('\nfirewall: published. The rules are live at Vercel\'s edge now (no redeploy needed):');
  vc(['firewall', 'rules', 'list']);
}
