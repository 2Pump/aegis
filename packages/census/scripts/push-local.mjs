// One-off: copy the census you built on your own computer (apps/web/public/census/) up to Vercel Blob,
// so the hourly GitHub job continues from it instead of re-scanning years of history through a throttled RPC.
// Uploads exactly what the job itself writes: census/known.json and census/census.json. Addresses + poses only.
//
// Run from the repo root (PowerShell):
//   $env:BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_..."
//   node packages/census/scripts/push-local.mjs
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { put } from '@vercel/blob';

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error('BLOB_READ_WRITE_TOKEN is not set. In PowerShell:  $env:BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_..."');
  process.exit(1);
}

const dir = join(process.cwd(), 'apps', 'web', 'public', 'census');
const load = async (name) => {
  try {
    return await readFile(join(dir, name), 'utf8');
  } catch {
    console.error(`Missing ${join(dir, name)} — run "pnpm census" on this computer first, from the repo root.`);
    process.exit(1);
  }
};

const knownRaw = await load('known.json');
const censusRaw = await load('census.json');
const known = JSON.parse(knownRaw);
const census = JSON.parse(censusRaw);

console.log(`local census: block ${census.block} · ${census.ships?.length ?? 0} ships · generated ${census.generatedAt}`);
console.log(
  `local discovery: tydro wallets ${Object.keys(known.tydro?.users ?? {}).length} (scanned to ${known.tydro?.scannedTo}) · ` +
    `nado owners ${Object.keys(known.nado?.subs ?? {}).length} (scanned to ${known.nado?.accountsScannedTo})`,
);

const opts = { access: 'public', token, contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60 };
// known.json first: if the census upload fails, the job still resumes from the right place
const k = await put('census/known.json', knownRaw, opts);
console.log(`uploaded ${k.url}`);
const c = await put('census/census.json', censusRaw, opts);
console.log(`uploaded ${c.url}`);
console.log('\nDone. VITE_CENSUS_URL for Vercel is:');
console.log(c.url);