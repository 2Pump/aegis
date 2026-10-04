/**
 * VERIFICATION RECORDS (pure; no IO) — one format for every check, by hand (`pnpm prove`) or automatic
 * (`pnpm verify:auto`, scheduled). A record keeps the rules and engine versions it ran under forever; it is never
 * relabelled, and an unreachable source is never a pass.
 */
/** Runs every 4 h; a result is STALE once it is older than 6 h (one missed run plus slack for GitHub's scheduler). */
export const VERIFY = { VERSION: 'verify-1.0.0', EVERY_HOURS: 4, STALE_HOURS: 6 } as const;

export type VVenue = 'tydro' | 'nado';
export type SourceType = 'official-app' | 'official-api' | 'on-chain';

export interface FieldCheck {
  id: string;
  label: string;
  /** the authoritative source's value; null = the source didn't give one */
  expected: number | null;
  /** what AEGIS read; null = AEGIS had no value */
  aegis: number | null;
  tolerance: number;
  /** 'abs': |a − e| ≤ tol · 'rel': |a − e| / max(|a|, |e|, tiny) ≤ tol */
  unit: 'abs' | 'rel';
  /** null = not compared (a value missing) — never counted as a pass */
  pass: boolean | null;
}

export interface VerificationRecord {
  v: 1;
  kind: 'manual' | 'auto';
  venue: VVenue;
  /** shortened address (0x1234…abcd) — public chain data, shown short on the site */
  wallet: string;
  /** what the case covers, e.g. "Tydro borrower", "Nado isolated subaccount" */
  case: string;
  source: string;
  sourceType: SourceType;
  at: string;
  block: number | null;
  rulesVersion: string;
  engineVersion: string | null;
  fields: FieldCheck[];
  /** NOT_CHECKED: no suitable wallet could be found this run — nothing was compared (never a pass, not a failure of AEGIS) */
  status: 'PASS' | 'FAIL' | 'SOURCE_UNAVAILABLE' | 'NOT_CHECKED';
  failureReason: string | null;
  sourceUnavailable: boolean;
}

export function compareField(f: Omit<FieldCheck, 'pass'>): FieldCheck {
  if (f.expected === null || f.aegis === null || !Number.isFinite(f.expected) || !Number.isFinite(f.aegis)) return { ...f, pass: null };
  const d = Math.abs(f.aegis - f.expected);
  const pass = f.unit === 'abs' ? d <= f.tolerance : d / Math.max(Math.abs(f.aegis), Math.abs(f.expected), 1e-12) <= f.tolerance;
  return { ...f, pass };
}

/** Status: unreachable → SOURCE_UNAVAILABLE; a stated failure, any mismatch or nothing compared → FAIL; else PASS. */
export function finalize(r: Omit<VerificationRecord, 'status' | 'failureReason'> & { failureReason?: string | null }): VerificationRecord {
  if (r.sourceUnavailable) return { ...r, status: 'SOURCE_UNAVAILABLE', failureReason: r.failureReason ?? 'the source could not be reached' };
  // a stated failure (e.g. AEGIS couldn't read the venue, or a machine check failed) is never turned into a pass
  if (r.failureReason) return { ...r, status: 'FAIL', failureReason: r.failureReason };
  const bad = r.fields.filter((f) => f.pass === false);
  const compared = r.fields.filter((f) => f.pass !== null);
  if (bad.length) return { ...r, status: 'FAIL', failureReason: r.failureReason ?? `${bad.length} field(s) outside tolerance: ${bad.map((f) => f.label).join(', ')}` };
  if (!compared.length) return { ...r, status: 'FAIL', failureReason: r.failureReason ?? 'nothing could be compared' };
  return { ...r, status: 'PASS', failureReason: null };
}

export type CheckDisplay = 'CURRENT' | 'STALE' | 'FAILED' | 'SOURCE UNAVAILABLE' | 'NOT CHECKED';

/** Every check the automatic run is meant to produce. One that has no record yet is shown as NOT CHECKED — never left out. */
export const EXPECTED_CHECKS: ReadonlyArray<{ venue: VVenue; sourceType: SourceType; case: string }> = [
  { venue: 'tydro', sourceType: 'on-chain', case: 'Tydro borrower' },
  { venue: 'nado', sourceType: 'on-chain', case: 'Nado default subaccount' },
  { venue: 'nado', sourceType: 'official-api', case: 'Nado default subaccount' },
  { venue: 'nado', sourceType: 'on-chain', case: 'Nado isolated subaccount' },
  { venue: 'nado', sourceType: 'official-api', case: 'Nado isolated subaccount' },
];

/** One name per case. (Early records named the isolated case "… (1 isolated)"; they belong to the same row.) */
export const caseName = (c: string) => c.replace(/\s*\(\d+ isolated\)$/, '');

/** A run that couldn't find a wallet for a case says so — a record with nothing compared, never a pass. */
export function notChecked(r: Omit<VerificationRecord, 'status' | 'fields' | 'sourceUnavailable' | 'failureReason' | 'block'> & { failureReason: string }): VerificationRecord {
  return { ...r, block: null, fields: [], sourceUnavailable: false, status: 'NOT_CHECKED' };
}

export function checkDisplay(r: VerificationRecord, nowMs: number, staleHours: number = VERIFY.STALE_HOURS): CheckDisplay {
  if (r.status === 'NOT_CHECKED') return 'NOT CHECKED';
  if (r.status === 'SOURCE_UNAVAILABLE') return 'SOURCE UNAVAILABLE';
  if (r.status === 'FAIL') return 'FAILED';
  const t = Date.parse(r.at);
  return Number.isFinite(t) && (nowMs - t) / 3_600_000 <= staleHours ? 'CURRENT' : 'STALE';
}

export interface CheckGroup {
  venue: VVenue;
  sourceType: SourceType;
  case: string;
  /** null = this expected check has never run */
  latest: VerificationRecord | null;
  display: CheckDisplay;
  lastSuccess: VerificationRecord | null;
  lastSuccessDisplay: CheckDisplay | null;
}

/**
 * Per venue × source type × case: the latest attempt, and the last success (kept visible when a newer attempt fails).
 * Every EXPECTED check gets a row, even with no record — a missing check is shown, never silently left out.
 */
export function latestChecks(records: readonly VerificationRecord[], nowMs: number, staleHours: number = VERIFY.STALE_HOURS): CheckGroup[] {
  const key = (v: string, t: string, c: string) => `${v}|${t}|${caseName(c)}`;
  const groups = new Map<string, VerificationRecord[]>();
  for (const e of EXPECTED_CHECKS) groups.set(key(e.venue, e.sourceType, e.case), []);
  for (const r of records) {
    const k = key(r.venue, r.sourceType, r.case);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const order = (g: CheckGroup) => `${g.venue === 'tydro' ? 0 : 1}${g.case}${g.sourceType}`;
  return [...groups.entries()]
    .map(([k, rs]): CheckGroup => {
      const [venue, sourceType, c] = k.split('|') as [VVenue, SourceType, string];
      const sorted = [...rs].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const latest = sorted[0] ?? null;
      const lastSuccess = sorted.find((r) => r.status === 'PASS') ?? null;
      return {
        venue,
        sourceType,
        case: c,
        latest,
        display: latest ? checkDisplay(latest, nowMs, staleHours) : 'NOT CHECKED',
        lastSuccess,
        lastSuccessDisplay: lastSuccess ? checkDisplay(lastSuccess, nowMs, staleHours) : null,
      };
    })
    .sort((a, b) => (order(a) < order(b) ? -1 : 1));
}

/**
 * Is an automatic run due? Due when the newest automatic record is at least `hours` old (or there is none).
 * The hourly census calls this, so checks run about every VERIFY.EVERY_HOURS without a separate timer.
 */
export function verifyDue(log: unknown, nowMs: number, hours: number): { due: boolean; why: string } {
  const recs = appendRecords(log, []).filter((r) => r.kind === 'auto');
  const last = recs.reduce((m, r) => Math.max(m, Date.parse(r.at) || 0), 0);
  if (!last) return { due: true, why: 'no automatic check on record yet' };
  const ageH = (nowMs - last) / 3_600_000;
  return ageH >= hours ? { due: true, why: `last automatic check ${ageH.toFixed(1)} h ago (≥ ${hours} h)` } : { due: false, why: `last automatic check ${ageH.toFixed(1)} h ago (< ${hours} h) — not due` };
}

/** Append without ever deleting history; refuses anything that isn't a record. */
export function appendRecords(log: unknown, add: readonly VerificationRecord[]): VerificationRecord[] {
  const prev = Array.isArray(log) ? (log as unknown[]).filter((x): x is VerificationRecord => !!x && (x as VerificationRecord).v === 1 && typeof (x as VerificationRecord).at === 'string') : [];
  return [...prev, ...add];
}

export const shortWallet = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
