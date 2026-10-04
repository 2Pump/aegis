/**
 * Book → Observation: the same classification, risk ladder and scenario engine the site uses — nothing alert-specific
 * about how risk is judged. Pure.
 */
import { SCENARIO_ENGINE_VERSION, classify, confidenceOf, directionById, directionScenario, nadoBuffer, shockBook, stressState, type Book } from '@aegis/pose';
import { scenarioKey, type AlertLevel, type Observation, type Watch } from './model.js';

export function levelOf(book: Book): AlertLevel {
  const st = stressState(book);
  if (st.liquidatable) return 'LIQ';
  return st.hullTemp === 'CRITICAL' ? 'NEAR' : st.hullTemp === 'ELEVATED' ? 'WATCH' : st.hullTemp === 'NOMINAL' ? 'SAFE' : 'UNKNOWN';
}

/** The worst (lowest) maintenance buffer across every Nado subaccount read — isolated positions are liquidated on their own. */
export function worstNadoBuffer(book: Book): number | null {
  if (book.nado.status !== 'OK') return null;
  const n = book.nado.data;
  const per = (n.subHealth ?? [])
    .map((s) => s.maintenance)
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .map((m) => (m.assetsUsd > 0 ? m.healthUsd / m.assetsUsd : m.healthUsd < 0 ? -1 : null))
    .filter((x): x is number => x !== null);
  return per.length ? Math.min(...per) : nadoBuffer(n);
}

/**
 * @param dataAt chain time of the block read (ms), when known
 * @param scenarios the scenarios any watcher of this wallet asked for
 */
export function observe(book: Book, opts: { readAt: number; dataAt: number | null; scenarios: ReadonlyArray<Watch['scenario']> }): Observation {
  const pose = classify(book);
  const t = book.tydro.status === 'OK' ? book.tydro.data : null;
  const n = book.nado.status === 'OK' ? book.nado.data : null;
  const conf = confidenceOf(book);
  const scenarios: Record<string, boolean | null> = {};
  for (const s of opts.scenarios) {
    if (!s) continue;
    const d = directionById(s.direction);
    scenarios[scenarioKey(s)] = !d || conf.confidence === 'UNSUPPORTED' ? null : stressState(shockBook(book, directionScenario(d, s.pct))).liquidatable;
  }
  return {
    address: book.address.toLowerCase(),
    readAt: opts.readAt,
    dataAt: opts.dataAt,
    block: book.asOfBlock,
    tydro: { readable: book.tydro.status === 'OK', active: !!t && (t.supplies.length > 0 || t.debts.length > 0), hf: t && t.debts.length && t.hf !== null && Number.isFinite(t.hf) ? t.hf : null },
    nado: { readable: book.nado.status === 'OK', active: !!n && (n.spots.length > 0 || n.perps.length > 0), worstBuffer: n ? worstNadoBuffer(book) : null, partial: n?.coverage?.status === 'PARTIAL' },
    level: levelOf(book),
    hullTemp: pose.hullTemp,
    primary: pose.primary,
    approximate: conf.confidence !== 'MODELLED',
    rulesVersion: pose.rulesVersion,
    engineVersion: SCENARIO_ENGINE_VERSION,
    scenarios,
  };
}
