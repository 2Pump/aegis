/**
 * Phrourax — Vercel Firewall rate limits for the public API (/api/v1). Run once; safe to run again.
 *
 *   $env:VERCEL_TOKEN="…"; pnpm firewall              # stage the rules, show them, publish, then verify they're live
 *   $env:VERCEL_TOKEN="…"; pnpm firewall --dry-run    # stage the rules, show them, then DISCARD (nothing goes live)
 *   options: --project <name> (default aegis-web) · --scope <team-slug> (only if the lookup asks for it)
 *
 * Talks to Vercel's REST API directly (the same calls the Vercel CLI makes: edit the firewall draft, then activate
 * it) — no CLI, no `.vercel` link, no shell quoting. If the project already has unpublished firewall edits, it stops
 * and changes nothing, so it can never publish someone else's half-finished draft.
 *
 * Rule names keep their original "AEGIS API - …" prefix: the script finds its rules by name (docs/BRAND.md).
 * The rules never overlap, so their order doesn't matter:
 *   1. live wallet scenario   /api/v1/wallets/…/scenario   15 per IP per minute (the API itself allows 6 per instance)
 *   2. webhook management     /api/v1/webhooks…            30 per IP per minute (API: 20 per instance)
 *   3. everything else        /api/v1…                     300 per IP per minute (API: 120 per instance; edge cache 60 s)
 * Over the limit → HTTP 429 at Vercel's edge, before the function runs. The site itself is not touched.
 * The token is never printed or stored. Use a short-lived token (vercel.com/account/tokens) and delete it after.
 */
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const DRY = args.includes('--dry-run');
const PROJECT = opt('--project', 'aegis-web');
const SCOPE = opt('--scope', process.env.VERCEL_SCOPE || '');
const TOKEN = (process.env.VERCEL_TOKEN || '').trim();

const cond = (value, op = 'pre', neg = false) => ({ type: 'raw_path', op, value, ...(neg ? { neg: true } : {}) });
const RULES = [
  {
    name: 'AEGIS API - live wallet scenario',
    description: 'Rate limit the one live endpoint (/api/v1/wallets/{address}/scenario): 15 per IP per minute -> 429',
    conditions: [cond('/api/v1/wallets/'), cond('/scenario', 'sub')],
    window: 60,
    limit: 15,
  },
  {
    name: 'AEGIS API - webhook management',
    description: 'Rate limit /api/v1/webhooks: 30 per IP per minute -> 429',
    conditions: [cond('/api/v1/webhooks')],
    window: 60,
    limit: 30,
  },
  {
    name: 'AEGIS API - read endpoints',
    description: 'Rate limit the rest of /api/v1: 300 per IP per minute -> 429 (excludes the two rules above)',
    conditions: [cond('/api/v1'), cond('/scenario', 'sub', true), cond('/api/v1/webhooks', 'pre', true)],
    window: 60,
    limit: 300,
  },
];
// all conditions in one group = AND
const ruleValue = (r) => ({
  name: r.name,
  description: r.description,
  active: true,
  conditionGroup: [{ conditions: r.conditions }],
  action: { mitigate: { action: 'rate_limit', rateLimit: { algo: 'fixed_window', window: r.window, limit: r.limit, keys: ['ip'], action: 'rate_limit' }, redirect: null, actionDuration: null } },
});

let staged = false;
let fwQuery = '';
async function api(path, { method = 'GET', body } = {}) {
  try {
    const r = await fetch(`https://api.vercel.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 300) };
    }
    return { status: r.status, ok: r.ok, body: json };
  } catch (e) {
    return { status: 0, ok: false, body: { error: { message: String(e?.message ?? e) } } };
  }
}
const why = (r) => `HTTP ${r.status}${r.body?.error?.message ? `: ${r.body.error.message}` : r.body?.raw ? `: ${r.body.raw}` : ''}`.split(TOKEN.length >= 8 ? TOKEN : '\u0000').join('<token>');
async function fail(msg) {
  if (staged) {
    const d = await api(`/v1/security/firewall/config/draft?${fwQuery}`, { method: 'DELETE' });
    msg += d.ok ? ' The staged draft was discarded.' : ` Discarding the staged draft also failed (${why(d)}) — discard it under Vercel → Firewall.`;
  }
  console.error(`firewall: ${msg}`);
  process.exit(1);
}

if (!TOKEN) await fail('set VERCEL_TOKEN first (vercel.com/account/tokens → Create, scope: the team that owns the project, short expiry). Nothing was changed.');

// 1 ── find the project (personal account + every team the token can see)
console.log(`firewall: looking up project "${PROJECT}"${SCOPE ? ` under "${SCOPE}"` : ''} …`);
const who = await api('/v2/user');
if (who.status === 0) await fail(`could not reach api.vercel.com (${who.body.error.message}). Nothing was changed.`);
const teamsRes = await api('/v2/teams?limit=100');
if (who.status === 401 && teamsRes.status === 401) await fail('Vercel says this token is not valid (deleted, expired or mistyped). Create a new one and set VERCEL_TOKEN again. Nothing was changed.');
const teams = Array.isArray(teamsRes.body?.teams) ? teamsRes.body.teams : [];
const scopes = [
  ...(SCOPE ? [] : [{ label: who.body?.user?.username ? `${who.body.user.username} (personal)` : "the token's own account", q: '' }]),
  ...teams.filter((t) => !SCOPE || t.slug === SCOPE || t.id === SCOPE).map((t) => ({ label: `${t.slug} (team)`, q: `teamId=${encodeURIComponent(t.id)}` })),
];
if (SCOPE && !scopes.length) await fail(`this token cannot see a team "${SCOPE}". Teams it can see: ${teams.map((t) => t.slug).join(', ') || 'none'}. Nothing was changed.`);
let found = null;
for (const sc of scopes) {
  const r = await api(`/v9/projects/${encodeURIComponent(PROJECT)}${sc.q ? `?${sc.q}` : ''}`);
  if (r.status === 200 && r.body?.id) {
    found = { projectId: r.body.id, accountId: r.body.accountId, where: sc.label };
    break;
  }
}
if (!found) {
  console.error('\nProjects this token can see:');
  for (const sc of scopes) {
    const r = await api(`/v9/projects?limit=100${sc.q ? `&${sc.q}` : ''}`);
    const names = Array.isArray(r.body?.projects) ? r.body.projects.map((p) => p.name) : [];
    console.error(`  ${sc.label}: ${r.status === 200 ? names.join(', ') || '(none)' : `not readable (${why(r)})`}`);
  }
  await fail(`no project called "${PROJECT}" in any of these. Rerun with --project <name from the list>. If the list is empty, the token's scope is wrong — recreate it with the team that owns the project. Nothing was changed.`);
}
fwQuery = new URLSearchParams({ projectId: found.projectId, ...(typeof found.accountId === 'string' && found.accountId.startsWith('team_') ? { teamId: found.accountId } : {}) }).toString();
console.log(`firewall: found "${PROJECT}" (${found.where})`);

// 2 ── current firewall: the live rules, and make sure there's no unpublished draft we'd sweep along
const cfg = await api(`/v1/security/firewall/config?${fwQuery}`);
if (!cfg.ok) await fail(`could not read the project's firewall (${why(cfg)}). Nothing was changed.`);
const draftChanges = Array.isArray(cfg.body?.draft?.changes) ? cfg.body.draft.changes : [];
if (draftChanges.length) {
  await fail(`the project already has ${draftChanges.length} unpublished firewall change(s) (Vercel → Firewall shows them). Publish or discard those first, then run this again. Nothing was changed.`);
}
const liveRules = Array.isArray(cfg.body?.active?.rules) ? cfg.body.active.rules : [];
const byName = new Map(liveRules.filter((r) => r?.name).map((r) => [r.name, r]));
console.log(`firewall: ${liveRules.length} rule(s) live now`);

// 3 ── stage each rule in the draft (insert, or update the one with the same name)
for (const r of RULES) {
  const existing = byName.get(r.name);
  const body = existing ? { action: 'rules.update', id: existing.id, value: ruleValue(r) } : { action: 'rules.insert', id: null, value: ruleValue(r) };
  const res = await api(`/v1/security/firewall/config/draft?${fwQuery}`, { method: 'PATCH', body });
  staged = true;
  if (!res.ok) await fail(`staging "${r.name}" failed (${why(res)}). Nothing was published.`);
  console.log(`firewall: ${existing ? 'update' : 'add'} "${r.name}" — ${r.limit} per IP per ${r.window}s → 429`);
}

// 4 ── review what the draft holds now
const after = await api(`/v1/security/firewall/config?${fwQuery}`);
const changes = Array.isArray(after.body?.draft?.changes) ? after.body.draft.changes : [];
console.log(`\nfirewall: the draft holds ${changes.length} change(s):`);
for (const c of changes) console.log(`  ${c.action === 'rules.insert' ? '+' : c.action === 'rules.remove' ? '-' : '~'} ${c.action}  ${c.value?.name ?? c.id ?? ''}`);
const foreign = changes.filter((c) => !RULES.some((r) => r.name === c.value?.name || (byName.get(r.name)?.id ?? null) === c.id));
if (foreign.length) await fail(`the draft also holds ${foreign.length} change(s) this script didn't make. Nothing was published.`);

// 5 ── publish (or discard on a dry run)
if (DRY) {
  const d = await api(`/v1/security/firewall/config/draft?${fwQuery}`, { method: 'DELETE' });
  staged = false;
  if (!d.ok) await fail(`discarding the dry-run draft failed (${why(d)}). Discard it under Vercel → Firewall.`);
  console.log('\nfirewall: DRY RUN — the draft was discarded. Nothing went live.');
  process.exit(0);
}
const pub = await api(`/v1/security/firewall/config/draft/activate?${fwQuery}`, { method: 'POST', body: {} });
if (!pub.ok) await fail(`publishing failed (${why(pub)}).`);
staged = false;

// 6 ── verify
const live = await api(`/v1/security/firewall/config?${fwQuery}`);
const liveNow = Array.isArray(live.body?.active?.rules) ? live.body.active.rules : [];
console.log("\nfirewall: published. Live now at Vercel's edge (no redeploy needed):");
let missing = 0;
for (const r of RULES) {
  const x = liveNow.find((y) => y?.name === r.name);
  const rl = x?.action?.mitigate?.rateLimit;
  if (!x || !x.active) missing++;
  console.log(`  ${x?.active ? 'OK ' : 'MISSING'} ${r.name}${rl ? ` — ${rl.limit} per ${rl.window}s per ${(rl.keys || []).join('+')}` : ''}`);
}
if (missing) await fail(`${missing} rule(s) not live after publishing — check Vercel → Firewall.`);
