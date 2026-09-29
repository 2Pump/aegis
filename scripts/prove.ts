/**
 * PROVE — read one real Ink address with the exact AEGIS sensors, cross-check it against
 * independent sources, then have a human confirm the numbers against the official UIs.
 *
 *   pnpm prove 0xYOURADDRESS                 # interactive (asks for the UI numbers)
 *   pnpm prove 0xYOURADDRESS --no-ask        # machine checks only
 *   pnpm prove 0x… --rpc https://…           # custom Ink RPC
 *
 * Runs in Node (no browser, no CORS), talks to Nado directly at api.prod.nado.xyz.
 * Writes verification/<address>-<utc>.json and, only when every check passes, updates
 * verification/status.json → venues.tydro / venues.nado (each venue can be proven on its own; verified = both).
 *
 * Read-only. No keys, no signing, no transactions.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseAbi, type Address } from 'viem';
import {
  INK_DEFAULT_RPC,
  NADO_DIRECT,
  TYDRO,
  TYDRO_RESERVES,
  makeInkClient,
  parseAddress,
  readBook,
} from '@aegis/ink-io';
import { classify, type Book } from '@aegis/pose';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const addrArg = args.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
const ask = !args.includes('--no-ask') && process.stdin.isTTY;
const rpc = flag('--rpc') ?? process.env.VITE_INK_RPC ?? INK_DEFAULT_RPC;

type Verdict = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
interface Check {
  id: string;
  what: string;
  aegis: string;
  other: string;
  source: string;
  verdict: Verdict;
}
const checks: Check[] = [];
const add = (c: Check) => {
  checks.push(c);
  const color = { PASS: '\x1b[36m', FAIL: '\x1b[31m', WARN: '\x1b[33m', SKIP: '\x1b[90m' }[c.verdict];
  console.log(`${color}${c.verdict.padEnd(4)}\x1b[0m  ${c.what.padEnd(44)} aegis=${c.aegis.padEnd(22)} ${c.source}=${c.other}`);
};
const rel = (a: number, b: number) => (a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-12));
const n = (x: number, d = 4) => (Number.isFinite(x) ? x.toLocaleString('en-US', { maximumFractionDigits: d }) : String(x));

const dataProviderAbi = parseAbi([
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
  'function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
]);
const oracleAbi = parseAbi(['function getAssetsPrices(address[] assets) view returns (uint256[])', 'function BASE_CURRENCY_UNIT() view returns (uint256)']);

async function main() {
  if (!addrArg) {
    console.error('usage: pnpm prove 0xADDRESS [--no-ask] [--rpc URL]');
    process.exit(2);
  }
  const pa = parseAddress(addrArg);
  if (!pa.ok) throw new Error(pa.error.message);
  const user = pa.value.lower;
  console.log(`\nAEGIS PROVE · ${pa.value.checksum}\nrpc ${rpc} · nado via Ink chain (FQuerier)\n`);

  /* ── 1. The exact sensors the app uses ── */
  const client = makeInkClient(rpc);
  const { book } = await readBook(user, { client, nado: { mode: 'chain', gatewayBase: NADO_DIRECT.gateway, archiveBase: NADO_DIRECT.archive } });
  const pose = classify(book);
  printBook(book);
  console.log(`\nPOSE  ${pose.tags.join(' + ') || 'NO RULE FIRED'}   HULL ${pose.hullTemp}`);
  pose.reasons.forEach((r) => console.log(`  · ${r}`));
  console.log('\n── machine cross-checks ─────────────────────────────────────────────');

  add({ id: 'tydro.sensor', what: 'Tydro sensor readable', aegis: book.tydro.status, other: book.tydro.status === 'DARK' ? `${book.tydro.code}: ${book.tydro.message}` : 'ok', source: 'self', verdict: book.tydro.status === 'OK' ? 'PASS' : 'FAIL' });
  add({ id: 'nado.sensor', what: 'Nado sensor readable', aegis: book.nado.status, other: book.nado.status === 'DARK' ? `${book.nado.code}: ${book.nado.message}` : 'ok', source: 'self', verdict: book.nado.status === 'OK' ? 'PASS' : 'FAIL' });

  /* ── 2. Tydro: independent path via AaveProtocolDataProvider at the SAME block ── */
  if (book.tydro.status === 'OK' && book.asOfBlock !== null) {
    const t = book.tydro.data;
    const blockNumber = BigInt(book.asOfBlock);
    const [unit, prices, userRes, cfgRes] = await Promise.all([
      client.readContract({ address: TYDRO.ORACLE, abi: oracleAbi, functionName: 'BASE_CURRENCY_UNIT', blockNumber }),
      client.readContract({ address: TYDRO.ORACLE, abi: oracleAbi, functionName: 'getAssetsPrices', args: [TYDRO_RESERVES.map((r) => r.underlying)], blockNumber }),
      Promise.all(TYDRO_RESERVES.map((r) => client.readContract({ address: TYDRO.AAVE_PROTOCOL_DATA_PROVIDER, abi: dataProviderAbi, functionName: 'getUserReserveData', args: [r.underlying, user as Address], blockNumber }))),
      Promise.all(TYDRO_RESERVES.map((r) => client.readContract({ address: TYDRO.AAVE_PROTOCOL_DATA_PROVIDER, abi: dataProviderAbi, functionName: 'getReserveConfigurationData', args: [r.underlying], blockNumber }))),
    ]);
    let weighted = 0;
    let debtUsd = 0;
    TYDRO_RESERVES.forEach((r, i) => {
      const sym = r.symbol === 'USDT' ? 'USDT0' : r.symbol;
      const u = userRes[i]!;
      const c = cfgRes[i]!;
      const px = Number(prices[i]!) / Number(unit);
      const sup = Number(u[0]) / 10 ** r.decimals;
      const debt = (Number(u[1]) + Number(u[2])) / 10 ** r.decimals;
      const aSup = t.supplies.find((s) => s.symbol === sym)?.amount ?? 0;
      const aDebt = t.debts.find((s) => s.symbol === sym)?.amount ?? 0;
      if (sup > 0 || aSup > 0) add({ id: `tydro.supply.${sym}`, what: `Tydro ${sym} supplied`, aegis: n(aSup, 8), other: n(sup, 8), source: 'DataProvider', verdict: rel(aSup, sup) < 1e-9 ? 'PASS' : 'FAIL' });
      if (debt > 0 || aDebt > 0) add({ id: `tydro.debt.${sym}`, what: `Tydro ${sym} borrowed`, aegis: n(aDebt, 8), other: n(debt, 8), source: 'DataProvider', verdict: rel(aDebt, debt) < 1e-9 ? 'PASS' : 'FAIL' });
      if (u[8] && sup > 0) weighted += sup * px * (Number(c[2]) / 10_000);
      debtUsd += debt * px;
    });
    if (t.hf !== null && debtUsd > 0) {
      const hf = weighted / debtUsd;
      add({ id: 'tydro.hf.recompute', what: 'Tydro HF (Pool) vs Σ(coll×LT)/debt', aegis: t.hf.toFixed(4), other: hf.toFixed(4), source: 'recomputed', verdict: rel(t.hf, hf) < 0.005 ? 'PASS' : 'FAIL' });
    } else {
      add({ id: 'tydro.hf.recompute', what: 'Tydro HF recompute', aegis: t.hf === null ? '∞' : t.hf.toFixed(4), other: 'no debt', source: 'recomputed', verdict: 'SKIP' });
    }
    add({ id: 'tydro.debt.total', what: 'Tydro Σ debt legs vs Pool totalDebt', aegis: n(t.debts.reduce((s, d) => s + d.usd, 0), 2), other: n(t.totalDebtUsd, 2), source: 'Pool', verdict: rel(t.debts.reduce((s, d) => s + d.usd, 0), t.totalDebtUsd) < 0.01 || t.totalDebtUsd < 1 ? 'PASS' : 'FAIL' });
    add({ id: 'tydro.notes', what: 'Tydro registry notes', aegis: t.notes.length ? t.notes.join(' | ') : 'none', other: '—', source: 'self', verdict: t.notes.length ? 'WARN' : 'PASS' });

    /* ── 3. Blockscout indexer: third, lagging source (warn only) ── */
    try {
      const res = await fetch(`https://explorer.inkonchain.com/api/v2/addresses/${pa.value.checksum}/token-balances`);
      const items = (await res.json()) as Array<{ token: { address_hash?: string; address?: string }; value: string }>;
      const byToken = new Map(items.map((it) => [(it.token.address_hash ?? it.token.address ?? '').toLowerCase(), it.value]));
      for (const r of TYDRO_RESERVES) {
        const sym = r.symbol === 'USDT' ? 'USDT0' : r.symbol;
        for (const [tok, side, legs] of [[r.aToken, 'supplied', t.supplies], [r.vToken, 'borrowed', t.debts]] as const) {
          const raw = byToken.get(tok.toLowerCase());
          const aegisAmt = legs.find((l) => l.symbol === sym)?.amount ?? 0;
          if (!raw && aegisAmt === 0) continue;
          const bs = raw ? Number(raw) / 10 ** r.decimals : 0;
          add({ id: `blockscout.${sym}.${side}`, what: `Blockscout ${sym} ${side} (indexer lags)`, aegis: n(aegisAmt, 6), other: n(bs, 6), source: 'Blockscout', verdict: rel(aegisAmt, bs) < 0.01 ? 'PASS' : 'WARN' });
        }
      }
    } catch (e) {
      add({ id: 'blockscout', what: 'Blockscout token balances', aegis: '—', other: String(e), source: 'Blockscout', verdict: 'SKIP' });
    }
  }

  /* ── 4. Nado: self-consistency (healths[2] vs computed equity) ── */
  if (book.nado.status === 'OK') {
    const nd = book.nado.data;
    const cross = nd.notes.find((x) => x.startsWith('healths[2]'));
    add({ id: 'nado.health.index', what: 'Nado healths[2] ≈ computed equity', aegis: n(nd.equityUsd, 2), other: n(nd.unweighted?.healthUsd ?? NaN, 2), source: 'Nado API', verdict: !cross ? 'SKIP' : cross.includes('OK') ? 'PASS' : 'FAIL' });
    const disc = nd.notes.find((x) => x.startsWith('Subaccount discovery'));
    add({ id: 'nado.discovery', what: 'Nado subaccount discovery (archive)', aegis: `${nd.subaccounts.length} subaccount(s)`, other: disc ?? 'ok', source: 'Nado archive', verdict: disc ? 'WARN' : 'PASS' });
  }

  /* ── 5. Human: compare against the official UIs ── */
  console.log('\n── official UI comparison ───────────────────────────────────────────');
  console.log('Open app.tydro.com / app.nado.xyz as THIS address — your own wallet, or a watch-only address in a');
  console.log('read-only wallet (e.g. Rabby → Add address → Import Watch-Only Address). Nothing is signed.');
  type Venue = 'tydro' | 'nado';
  const ui: Array<{ id: string; venue: Venue; label: string; aegis: number | null; tol: number; unit: 'abs' | 'rel' }> = [];
  const tydroHas = book.tydro.status === 'OK' && (book.tydro.data.supplies.length > 0 || book.tydro.data.debts.length > 0);
  const nadoHas = book.nado.status === 'OK' && (book.nado.data.spots.length > 0 || book.nado.data.perps.length > 0);
  if (book.tydro.status === 'OK' && tydroHas) {
    const t = book.tydro.data;
    // labels = what the Tydro Dashboard shows
    if (t.hf !== null) ui.push({ id: 'ui.tydro.hf', venue: 'tydro', label: 'Tydro · Health Factor', aegis: t.hf, tol: 0.01, unit: 'abs' });
    ui.push({ id: 'ui.tydro.assets', venue: 'tydro', label: 'Tydro · Assets (USD)', aegis: t.supplies.reduce((a, l) => a + l.usd, 0), tol: 0.01, unit: 'rel' });
    if (t.debts.length) ui.push({ id: 'ui.tydro.liabilities', venue: 'tydro', label: 'Tydro · Liabilities (USD)', aegis: t.debts.reduce((a, l) => a + l.usd, 0), tol: 0.01, unit: 'rel' });
    for (const l of t.supplies) ui.push({ id: `ui.tydro.supply.${l.symbol}`, venue: 'tydro', label: `Tydro · Assets · ${l.symbol} Amount`, aegis: l.amount, tol: 0.001, unit: 'rel' });
    for (const l of t.debts) ui.push({ id: `ui.tydro.debt.${l.symbol}`, venue: 'tydro', label: `Tydro · Liabilities · ${l.symbol} Amount`, aegis: l.amount, tol: 0.001, unit: 'rel' });
  }
  if (book.nado.status === 'OK' && nadoHas) {
    const nd = book.nado.data;
    ui.push({ id: 'ui.nado.equity', venue: 'nado', label: 'Nado · Account value / equity (USD)', aegis: nd.equityUsd, tol: 0.01, unit: 'rel' });
    for (const p of nd.perps) ui.push({ id: `ui.nado.perp.${p.symbol}`, venue: 'nado', label: `Nado · ${p.symbol} position size (signed)`, aegis: p.sizeBase, tol: 0.0001, unit: 'rel' });
    for (const sp of nd.spots) ui.push({ id: `ui.nado.spot.${sp.symbol}`, venue: 'nado', label: `Nado · ${sp.symbol} balance`, aegis: sp.amount, tol: 0.001, unit: 'rel' });
  }
  if (!tydroHas) console.log('  (Tydro: no positions on this address — nothing to compare)');
  if (!nadoHas) console.log('  (Nado: no positions on this address — nothing to compare)');
  if (ask && ui.length) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log('Type the number the official UI shows (Enter = skip). Tolerance: HF ±0.01, USD ±1%, amounts ±0.1%, perp sizes ±0.01%.');
    console.log('Read the UI right now — prices and interest move, so compare numbers from the same minute.\n');
    for (const f of ui) {
      const ans = (await rl.question(`${f.label}  [AEGIS: ${n(f.aegis ?? NaN, 6)}]  UI = `)).replace(/[$,\s]/g, '');
      if (!ans) {
        add({ id: f.id, what: f.label, aegis: n(f.aegis ?? NaN, 6), other: '—', source: 'official UI', verdict: 'SKIP' });
        continue;
      }
      const v = Number(ans);
      const ok = f.aegis !== null && Number.isFinite(v) && (f.unit === 'abs' ? Math.abs(v - f.aegis) <= f.tol : rel(v, f.aegis) <= f.tol);
      add({ id: f.id, what: f.label, aegis: n(f.aegis ?? NaN, 6), other: ans, source: 'official UI', verdict: ok ? 'PASS' : 'FAIL' });
    }
    rl.close();
  } else if (ui.length) {
    ui.forEach((f) => console.log(`  ${f.label.padEnd(44)} AEGIS ${n(f.aegis ?? NaN, 6)}   UI ______`));
  }

  /* ── 6. Verdict per venue + record ──
     A venue is PROVEN when: its sensor was readable, the address has positions there, none of that venue's
     machine checks FAILED, and every one of that venue's UI fields was typed in and matched (no skips). */
  const venueOf = (id: string): Venue | null =>
    id.startsWith('tydro.') || id.startsWith('blockscout') || id.startsWith('ui.tydro.') ? 'tydro' : id.startsWith('nado.') || id.startsWith('ui.nado.') ? 'nado' : null;
  const provenVenue = (v: Venue) => {
    const has = v === 'tydro' ? tydroHas : nadoHas;
    const mine = checks.filter((c) => venueOf(c.id) === v);
    const fields = ui.filter((f) => f.venue === v);
    const matched = mine.filter((c) => c.id.startsWith('ui.') && c.verdict === 'PASS').length;
    return has && fields.length > 0 && !mine.some((c) => c.verdict === 'FAIL') && matched === fields.length;
  };
  const venues: Venue[] = (['tydro', 'nado'] as const).filter(provenVenue);
  const proven = venues.length > 0;
  const fails = checks.filter((c) => c.verdict === 'FAIL');
  const uiPass = checks.filter((c) => c.id.startsWith('ui.') && c.verdict === 'PASS');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(root, 'verification');
  mkdirSync(dir, { recursive: true });
  const record = {
    address: pa.value.checksum,
    at: new Date().toISOString(),
    block: book.asOfBlock,
    rpc,
    nado: 'ink-chain:FQuerier',
    rulesVersion: pose.rulesVersion,
    pose: { tags: pose.tags, hullTemp: pose.hullTemp, reasons: pose.reasons },
    checks,
    provenVenues: venues,
  };
  const file = join(dir, `${user}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n');

  console.log('\n── verdict ──────────────────────────────────────────────────────────');
  console.log(`checks: ${checks.filter((c) => c.verdict === 'PASS').length} pass · ${fails.length} fail · ${checks.filter((c) => c.verdict === 'WARN').length} warn · ${checks.filter((c) => c.verdict === 'SKIP').length} skip`);
  console.log(`official UI: ${uiPass.length}/${ui.length} fields matched`);
  for (const v of ['tydro', 'nado'] as const) {
    const has = v === 'tydro' ? tydroHas : nadoHas;
    console.log(`  ${v.padEnd(6)} ${venues.includes(v) ? '\x1b[36mPROVEN\x1b[0m' : has ? '\x1b[31mnot proven\x1b[0m (a check failed or a UI field was skipped)' : 'not tested (no positions here)'}`);
  }
  console.log(`record: ${file}`);

  if (proven) {
    const statusFile = join(dir, 'status.json');
    const status = JSON.parse(readFileSync(statusFile, 'utf8')) as { verified: boolean; venues?: Record<string, boolean>; proofs: unknown[] };
    status.venues = { tydro: false, nado: false, ...(status.venues ?? {}) };
    for (const v of venues) status.venues[v] = true;
    status.verified = status.venues.tydro === true && status.venues.nado === true;
    status.proofs = [
      ...status.proofs,
      { address: `${pa.value.checksum.slice(0, 6)}…${pa.value.checksum.slice(-4)}`, at: record.at, block: record.block, fields: uiPass.length, rulesVersion: record.rulesVersion, venues },
    ];
    writeFileSync(statusFile, JSON.stringify(status, null, 2) + '\n');
    console.log(`\x1b[36mPROVEN: ${venues.join(' + ')}\x1b[0m — verification/status.json updated. ${status.verified ? 'Both venues verified: the PREVIEW label comes off on the next deploy.' : 'The other venue is still pending.'}`);
    console.log('Commit the record and status.json (git add -A; git commit; git push) so the site shows it.');
  } else {
    console.log('\x1b[31mNOT PROVEN\x1b[0m — nothing changed. Send a screenshot of this output.');
    process.exitCode = 1;
  }
}

function printBook(b: Book) {
  console.log('TYDRO');
  if (b.tydro.status === 'DARK') console.log(`  DARK ${b.tydro.code}: ${b.tydro.message}`);
  else {
    const t = b.tydro.data;
    console.log(`  block ${b.asOfBlock}  HF ${t.hf === null ? '∞ (no debt)' : t.hf.toFixed(4)}  collateral $${n(t.totalCollateralUsd, 2)}  debt $${n(t.totalDebtUsd, 2)}  LT ${t.liquidationThreshold ?? '—'}`);
    t.supplies.forEach((s) => console.log(`  SUPPLY ${s.symbol.padEnd(9)} ${n(s.amount, 8).padStart(20)}  $${n(s.usd, 2)} @ ${n(s.priceUsd, 2)} [${s.priceSource}]`));
    t.debts.forEach((s) => console.log(`  DEBT   ${s.symbol.padEnd(9)} ${n(s.amount, 8).padStart(20)}  $${n(s.usd, 2)} @ ${n(s.priceUsd, 2)} [${s.priceSource}]`));
  }
  console.log('NADO');
  if (b.nado.status === 'DARK') console.log(`  DARK ${b.nado.code}: ${b.nado.message}`);
  else {
    const d = b.nado.data;
    console.log(`  equity $${n(d.equityUsd, 2)}  maint ${d.maintenance ? `${n(d.maintenance.healthUsd, 2)} / ${n(d.maintenance.assetsUsd, 2)}` : '—'}  subaccounts ${d.subaccounts.length}`);
    d.spots.forEach((s) => console.log(`  SPOT   ${s.symbol.padEnd(9)} ${n(s.amount, 8).padStart(20)}  $${n(s.usd, 2)} [${s.priceSource}]`));
    d.perps.forEach((p) => console.log(`  PERP   ${p.symbol.padEnd(12)} ${n(p.sizeBase, 6).padStart(17)}  notional $${n(p.notionalUsd, 2)}  unsettled $${n(p.unsettledUsd, 2)}`));
    d.notes.forEach((x) => console.log(`  note: ${x}`));
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
