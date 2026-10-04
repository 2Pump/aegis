/**
 * VERIFICATION RECORDS (pure; no IO) — one format for every check, by hand (`pnpm prove`) or automatic
 * (`pnpm verify:auto`, scheduled). A record keeps the rules and engine versions it ran under forever; it is never
 * relabelled, and an unreachable source is never a pass.
 */
export const VERIFY = { VERSION: 'verify-1.0.0', STALE_HOURS: 24 } as const;

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
  status: 'PASS' | 'FAIL' | 'SOURCE_UNAVAILABLE';
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

export type CheckDisplay = 'CURRENT' | 'STALE' | 'FAILED' | 'SOURCE UNAVAILABLE';

export function checkDisplay(r: VerificationRecord, nowMs: number, staleHours: number = VERIFY.STALE_HOURS): CheckDisplay {
  if (r.status === 'SOURCE_UNAVAILABLE') return 'SOURCE UNAVAILABLE';
  if (r.status === 'FAIL') return 'FAILED';
  const t = Date.parse(r.at);
  return Number.isFinite(t) && (nowMs - t) / 3_600_000 <= staleHours ? 'CURRENT' : 'STALE';
}

/** Per venue × source type × case: the latest attempt, and the last success (kept visible when a newer attempt fails). */
export function latestChecks(records: readonly VerificationRecord[], nowMs: number, staleHours: number = VERIFY.STALE_HOURS) {
  const groups = new Map<string, VerificationRecord[]>();
  for (const r of records) {
    const k = `${r.venue}|${r.sourceType}|${r.case}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()]
    .map((rs) => {
      const sorted = [...rs].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const latest = sorted[0]!;
      const lastSuccess = sorted.find((r) => r.status === 'PASS') ?? null;
      return { venue: latest.venue, sourceType: latest.sourceType, case: latest.case, latest, display: checkDisplay(latest, nowMs, staleHours), lastSuccess, lastSuccessDisplay: lastSuccess ? checkDisplay(lastSuccess, nowMs, staleHours) : null };
    })
    .sort((a, b) => (a.venue + a.case < b.venue + b.case ? -1 : 1));
}

/** Append without ever deleting history; refuses anything that isn't a record. */
export function appendRecords(log: unknown, add: readonly VerificationRecord[]): VerificationRecord[] {
  const prev = Array.isArray(log) ? (log as unknown[]).filter((x): x is VerificationRecord => !!x && (x as VerificationRecord).v === 1 && typeof (x as VerificationRecord).at === 'string') : [];
  return [...prev, ...add];
}

export const shortWallet = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
