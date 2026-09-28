import { PRIMARY_PRIORITY, RULES, type RulesConfig } from './config.js';
import { isKbtc } from './families.js';
import type {
  AssetClass,
  Book,
  FamilyRow,
  HullTemp,
  NadoBook,
  Pose,
  PoseMetrics,
  Tag,
  TydroBook,
} from './types.js';

/* ────────────────────────────── formatting (pure) ────────────────────────────── */

export function usd(n: number): string {
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 0 : 2;
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
export function pct(f: number, digits = 1): string {
  return `${(f * 100).toFixed(digits)}%`;
}
function num(n: number, digits = 2): string {
  return n.toFixed(digits);
}

/* ────────────────────────────── derived sensor numbers ────────────────────────────── */

/** Nado maintenance buffer = maintHealth / maintAssets. < 0 means liquidatable. */
export function nadoBuffer(n: NadoBook | null): number | null {
  if (!n || !n.maintenance) return null;
  const { assetsUsd, healthUsd } = n.maintenance;
  if (assetsUsd > 0) return healthUsd / assetsUsd;
  if (healthUsd < 0) return -1;
  return null;
}

/** Tydro liquidation distance ≈ fraction collateral value can fall (debt fixed) before HF = 1. */
export function tydroLiqDistance(hf: number | null): number | null {
  if (hf === null || !Number.isFinite(hf) || hf <= 0) return null;
  return 1 - 1 / hf;
}

/* ────────────────────────────── family table ────────────────────────────── */

interface Acc {
  assetClass: AssetClass;
  S: number;
  L: number;
  P: number;
}

function buildFamilies(t: TydroBook | null, n: NadoBook | null): Map<string, Acc> {
  const m = new Map<string, Acc>();
  const get = (family: string, assetClass: AssetClass): Acc => {
    let a = m.get(family);
    if (!a) {
      a = { assetClass, S: 0, L: 0, P: 0 };
      m.set(family, a);
    }
    return a;
  };
  if (n) {
    for (const s of n.spots) get(s.family, s.assetClass).S += s.usd;
    for (const p of n.perps) {
      const a = get(p.family, p.assetClass);
      if (p.notionalUsd >= 0) a.L += p.notionalUsd;
      else a.P += -p.notionalUsd;
    }
  }
  if (t) {
    for (const s of t.supplies) get(s.family, s.assetClass).S += s.usd;
    for (const d of t.debts) get(d.family, d.assetClass).S -= Math.abs(d.usd);
  }
  return m;
}

/* ────────────────────────────── the classifier ────────────────────────────── */

export function classify(book: Book, cfg: RulesConfig = RULES): Pose {
  const reasons: string[] = [];
  const darkReasons: string[] = [];

  const t = book.tydro.status === 'OK' ? book.tydro.data : null;
  const n = book.nado.status === 'OK' ? book.nado.data : null;
  if (book.tydro.status === 'DARK') darkReasons.push(`TYDRO_SENSOR: ${book.tydro.code} — ${book.tydro.message}`);
  if (book.nado.status === 'DARK') darkReasons.push(`NADO_SENSOR: ${book.nado.code} — ${book.nado.message}`);

  const hf = t ? t.hf : null;
  const buf = nadoBuffer(n);
  const liq = tydroLiqDistance(hf);

  /* WOUNDED — evaluated on whatever sensors ARE readable. A wound seen on one venue is real. */
  const woundReasons: string[] = [];
  if (hf !== null && hf < cfg.WOUNDED_HF) woundReasons.push(`WOUNDED · Tydro HF ${num(hf)} < ${cfg.WOUNDED_HF}`);
  if (buf !== null && buf < cfg.NADO_BUFFER_CRIT)
    woundReasons.push(`WOUNDED · Nado maintenance buffer ${pct(buf)} < ${pct(cfg.NADO_BUFFER_CRIT, 0)}`);
  if (liq !== null && liq < cfg.LIQ_DISTANCE_CRIT)
    woundReasons.push(`WOUNDED · Tydro liquidation distance ${pct(liq)} < ${pct(cfg.LIQ_DISTANCE_CRIT, 0)}`);
  const wounded = woundReasons.length > 0;

  /* metrics */
  const fam = buildFamilies(t, n);
  const nadoPos = n ? n.spots.filter((s) => s.usd > 0) : [];
  const tSup = t ? t.supplies : [];
  const nadoCollateralUsd = sum(nadoPos.map((s) => s.usd));
  const tydroSupplyUsd = sum(tSup.map((s) => s.usd));
  const totalMarginUsd = nadoCollateralUsd + tydroSupplyUsd;
  const eq = sum([...nadoPos, ...tSup].filter((s) => s.assetClass === 'XSTOCK').map((s) => s.usd));
  const kb = sum([...nadoPos, ...tSup].filter((s) => isKbtc(s.symbol)).map((s) => s.usd));
  const st = sum([...nadoPos, ...tSup].filter((s) => s.assetClass === 'STABLE').map((s) => s.usd));
  const grossPerpUsd = n ? sum(n.perps.map((p) => Math.abs(p.notionalUsd))) : 0;
  const grossUsd =
    grossPerpUsd +
    (n ? sum(n.spots.map((s) => Math.abs(s.usd))) : 0) +
    (t ? sum([...t.supplies, ...t.debts].map((s) => Math.abs(s.usd))) : 0);
  const E = n ? n.equityUsd : null;

  const families: FamilyRow[] = [];
  let S = 0;
  let L = 0;
  let P = 0;
  for (const [family, a] of fam) {
    if (a.assetClass === 'STABLE') continue; // stables have no perp to hedge against
    const Spos = Math.max(a.S, 0);
    const both = Spos > 0 && a.P > 0;
    const carryGap = both ? Math.abs(Spos - a.P) / Math.max(Spos, a.P, 1) : null;
    const carry = carryGap !== null && carryGap <= cfg.CARRY_BAND && Math.min(Spos, a.P) >= cfg.CARRY_MIN_LEG_USD;
    const gross = a.L + a.P;
    const naked = gross >= cfg.NAKED_MIN_GROSS_USD && !carry && Math.abs(a.L - a.P) / Math.max(gross, 1) > cfg.NAKED_IMBALANCE;
    families.push({ family, assetClass: a.assetClass, S: a.S, L: a.L, P: a.P, carryGap, carry, naked, residualUsd: a.S + a.L - a.P });
    S += Spos;
    L += a.L;
    P += a.P;
  }
  families.sort((x, y) => Math.abs(y.S) + y.L + y.P - (Math.abs(x.S) + x.L + x.P));

  const metrics: PoseMetrics = {
    S, P, L, E, hf, nadoBuffer: buf, eq, kb, st, totalMarginUsd, nadoCollateralUsd, grossPerpUsd, grossUsd, families,
  };
  const liqDistanceBps = liq === null ? null : Math.round(liq * 10_000);
  const base = { metrics, liqDistanceBps, rulesVersion: cfg.RULES_VERSION, darkReasons };

  /* ── DARK: a required sensor failed. Never guess S or P from half a book. ── */
  if (darkReasons.length > 0) {
    reasons.push(
      `DARK · ${darkReasons.length === 2 ? 'both sensors' : darkReasons[0]!.split(':')[0]} unreadable — positional rules (CARRY, NAKED, …) not evaluated`,
    );
    reasons.push(...woundReasons);
    const tags: Tag[] = wounded ? ['DARK', 'WOUNDED'] : ['DARK'];
    return { ...base, tags, primary: 'DARK', residualDeltaUsd: null, residualDeltaFrac: null, hullTemp: wounded ? 'CRITICAL' : 'UNKNOWN', reasons };
  }

  /* ── EMPTY ── */
  if (grossUsd < cfg.DUST_USD) {
    reasons.push(`EMPTY · gross exposure ${usd(grossUsd)} < dust ${usd(cfg.DUST_USD)} on Tydro + Nado`);
    return { ...base, tags: ['EMPTY'], primary: 'EMPTY', residualDeltaUsd: 0, residualDeltaFrac: 0, hullTemp: 'NOMINAL', reasons };
  }

  const fired = new Set<Tag>();

  for (const f of families) {
    if (f.carry && f.carryGap !== null) {
      fired.add('CARRY');
      reasons.push(
        `CARRY · ${f.family}: spot-like ${usd(Math.max(f.S, 0))} vs short perp ${usd(f.P)} → gap ${pct(f.carryGap)} ≤ ${pct(cfg.CARRY_BAND, 0)}, min leg ${usd(Math.min(f.S, f.P))} ≥ ${usd(cfg.CARRY_MIN_LEG_USD)}`,
      );
    }
  }
  for (const f of families) {
    if (f.naked) {
      fired.add('NAKED');
      const imb = Math.abs(f.L - f.P) / Math.max(f.L + f.P, 1);
      reasons.push(
        `NAKED · ${f.family}: long perp ${usd(f.L)}, short perp ${usd(f.P)} → imbalance ${pct(imb)} > ${pct(cfg.NAKED_IMBALANCE, 0)}, not hedged by spot`,
      );
    }
  }

  const eqShare = eq / Math.max(nadoCollateralUsd, eq, 1);
  if (eq >= cfg.EQUITY_MIN_USD && eqShare >= cfg.EQUITY_SHARE && n !== null && (n.perps.length > 0 || eq > 0)) {
    fired.add('EQUITY-MARGIN');
    reasons.push(`EQUITY-MARGIN · xStocks ${usd(eq)} = ${pct(eqShare)} of Nado collateral (≥ ${pct(cfg.EQUITY_SHARE, 0)}) — tokenized equities posted as unified margin`);
  }

  const kbShare = kb / Math.max(totalMarginUsd, 1);
  if (kb >= cfg.KBTC_MIN_USD && kbShare >= cfg.KBTC_SHARE) {
    fired.add('KBTC-CORE');
    reasons.push(`KBTC-CORE · kBTC ${usd(kb)} = ${pct(kbShare)} of total margin ${usd(totalMarginUsd)} (≥ ${pct(cfg.KBTC_SHARE, 0)})`);
  }

  const nadoRiskSpots = n ? n.spots.filter((s) => Math.abs(s.usd) >= cfg.DUST_USD && (s.usd < 0 || s.assetClass !== 'STABLE')) : [];
  const nadoPerps = n ? n.perps.filter((p) => Math.abs(p.notionalUsd) >= cfg.DUST_USD) : [];
  if (tydroSupplyUsd > cfg.LOCKED_MIN_SUPPLY_USD && nadoPerps.length === 0 && nadoRiskSpots.length === 0) {
    fired.add('LOCKED');
    reasons.push(`LOCKED · Tydro supplies ${usd(tydroSupplyUsd)} > ${usd(cfg.LOCKED_MIN_SUPPLY_USD)}, no Nado perps, no Nado risk spots`);
  }

  const stShare = st / Math.max(totalMarginUsd, 1);
  if (st > 0 && stShare >= cfg.STABLE_SHARE) {
    fired.add('STABLE-BALLAST');
    reasons.push(`STABLE-BALLAST · stables ${usd(st)} = ${pct(stShare)} of total margin (≥ ${pct(cfg.STABLE_SHARE, 0)})`);
  }

  if (E !== null && grossPerpUsd > 0) {
    const lev = grossPerpUsd / Math.max(E, 1);
    if (lev >= cfg.LEVERED_RATIO) {
      fired.add('LEVERED');
      reasons.push(`LEVERED · gross perp ${usd(grossPerpUsd)} / equity ${usd(E)} = ${num(lev, 2)}× ≥ ${cfg.LEVERED_RATIO}×`);
    }
  }

  reasons.push(...woundReasons);

  const primary: Tag | null = PRIMARY_PRIORITY.find((tag) => fired.has(tag)) ?? (wounded ? 'WOUNDED' : null);
  const tags: Tag[] = [];
  if (primary) tags.push(primary);
  if (wounded && primary !== 'WOUNDED') tags.push('WOUNDED');
  for (const tag of PRIMARY_PRIORITY) if (fired.has(tag) && tag !== primary) tags.push(tag);
  if (!primary) reasons.push('NO RULE FIRED · book is readable but matches no published pose');

  let hullTemp: HullTemp = 'NOMINAL';
  if (wounded) hullTemp = 'CRITICAL';
  else if ((hf !== null && hf < cfg.ELEVATED_HF) || (buf !== null && buf < cfg.NADO_BUFFER_WARN)) hullTemp = 'ELEVATED';

  const residualDeltaUsd = sum(families.map((f) => f.residualUsd));
  const exposure = sum(families.map((f) => Math.abs(f.S) + f.L + f.P));
  const residualDeltaFrac = residualDeltaUsd / Math.max(exposure, 1);

  // Reasons read in the same order as the tags: primary's "why" first.
  const rank = (r: string) => {
    const i = tags.findIndex((t) => r.startsWith(`${t} ·`));
    return i === -1 ? tags.length : i;
  };
  const ordered = reasons.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);

  return { ...base, tags, primary, residualDeltaUsd, residualDeltaFrac, hullTemp, reasons: ordered };
}

function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}
