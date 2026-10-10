import { Link } from 'react-router-dom';
import { RULES, SCENARIO_ENGINE_VERSION, classify } from '@aegis/pose';
import { VERIFY, caseName, latestChecks, type CheckDisplay } from '@aegis/census';
import { useVerificationLog } from '../lib/verificationLog';
import { ForecastTrack, TrackRecord, TrackRecordGuide } from '../components/TrackRecord';
import { fmtAge } from '../lib/fmt';
import { useNow } from '../lib/hulls';
import { RISK_LABEL, brandText } from '@aegis/glyphs';
import { Panel, TagChip } from '../components/bits';
import { FIXTURES } from '../lib/fixtures';
import { PROOFS, PROOF_STALE_DAYS, VENUE_VERIFIED, VERIFIED, proofStatus, verificationText } from '../lib/verification';

/** Synthetic books + proof status. Nothing on this page is a real account. */
export function CalibrationPage() {
  return (
    <div className="stack">
      <h2 className="page">Checks</h2>
      <div className="mono dim" style={{ fontSize: 12 }} data-testid="versions-now">
        Now running: rules <b>{RULES.RULES_VERSION}</b> · scenario engine <b>{SCENARIO_ENGINE_VERSION}</b> · checks {VERIFY.VERSION}. Every check below keeps the versions it ran
        under.
      </div>

      <AutoChecks />

      <TrackRecordGuide />
      <TrackRecord />

      <ForecastTrack />

      <div className="faint mono" style={{ fontSize: 11 }}>The same checks, scores and readings are available as JSON: <Link to="/developers">developers → Public Risk API</Link>.</div>

      <Panel title="Matched against the official apps — by hand" rail={VERIFIED ? 'var(--cyan)' : VENUE_VERIFIED.tydro || VENUE_VERIFIED.nado ? 'var(--amber)' : 'var(--red)'} testId="proof-panel">
        {VERIFIED || VENUE_VERIFIED.tydro || VENUE_VERIFIED.nado ? (
          <div className="stack" style={{ gap: 8 }}>
            <div className={`banner${VERIFIED ? ' cyan' : ''}`}>{VERIFIED ? 'CHECKED' : 'PARTLY CHECKED'} — {verificationText()}.</div>
            <div className="mono dim" style={{ fontSize: 12 }} data-testid="rules-now">
              Current rules: <b>{RULES.RULES_VERSION}</b>. Each check below keeps the rules version it ran under; a check is never relabelled. The readings
              it matched (balances, health factor, positions) don't depend on the rules; the position type can.
            </div>
            <ul className="reasons" data-testid="proof-list">
              {PROOFS.map((p) => {
                const st = proofStatus(p, RULES.RULES_VERSION);
                const { stale, ageDays: age } = st;
                const older = st.olderRules;
                return (
                  <li key={p.at} data-testid="proof-row" data-stale={stale ? '1' : '0'}>
                    MATCHED · {(p.venues ?? ['tydro', 'nado']).map((v) => `${v}${p.sources?.[v] === 'api' ? ' (official API)' : ' (official app)'}`).join(' + ')} · {p.address} · block {p.block ?? '?'} ·{' '}
                    {p.fields} fields matched · ran under rules {st.ranUnder}
                    {older ? <b className="proof-old"> (older than the current {RULES.RULES_VERSION})</b> : null} · {p.at}
                    {stale ? <b className="proof-stale"> · STALE: {age === null ? 'unknown age' : `${Math.floor(age)} days old`} (re-check after {PROOF_STALE_DAYS})</b> : null}
                  </li>
                );
              })}
            </ul>
            <div className="mono dim" style={{ fontSize: 12 }}>
              Re-check any time: <code>pnpm prove 0xADDRESS</code> reads a wallet exactly the way this site does, compares it with the official app or API, and
              records the time, block, rules version, source and every field it checked. A source it can't reach is recorded as not checked, never as a pass.
            </div>
          </div>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            <div className="banner red">NOT YET CHECKED — no real wallet has been matched against app.tydro.com / app.nado.xyz yet.</div>
            <div className="mono dim" style={{ fontSize: 12 }}>
              Run on your machine: <code>pnpm prove 0xYOUR_ADDRESS</code> — reads the wallet exactly the way this site does, cross-checks Tydro against the
              protocol data provider and Blockscout, then asks you for the official UI numbers.
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Test wallets — made up" rail="var(--slate)" right={<span className="mono">the six dossier examples</span>}>
        <div className="table-wrap">
          <table className="t" data-testid="fixture-list">
            <thead>
              <tr><th>Test wallet</th><th>Position type</th><th>Risk</th></tr>
            </thead>
            <tbody>
              {Object.entries(FIXTURES).map(([name, b]) => {
                const p = classify(b);
                return (
                  <tr key={name}>
                    <td className="mono"><Link to={`/fixture/${name}`}>{b.label ?? name}</Link><span className="src">TEST</span></td>
                    <td><div className="tags">{p.tags.map((t) => <TagChip key={t} tag={t} />)}</div></td>
                    <td className="mono">{RISK_LABEL[p.hullTemp]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

const DISPLAY_TONE: Record<CheckDisplay, string> = { CURRENT: 'var(--cyan)', STALE: 'var(--amber)', FAILED: 'var(--red)', 'SOURCE UNAVAILABLE': 'var(--slate)', 'NOT CHECKED': 'var(--amber)' };
const SOURCE_TYPE: Record<string, string> = { 'on-chain': 'on-chain contract', 'official-api': 'official API', 'official-app': 'official app' };

/** The automatic cross-checks every 4 h (verify.yml). Real wallets, compared with authoritative sources Phrourax doesn't read from. */
function AutoChecks() {
  const log = useVerificationLog();
  const now = useNow(60_000);
  return (
    <Panel title={`Automatic checks — every ${VERIFY.EVERY_HOURS} h`} rail="var(--cyan)" testId="auto-checks" right={<span className="mono">stale after {VERIFY.STALE_HOURS} h</span>}>
      {log.status === 'loading' ? <div className="dim">Loading…</div> : null}
      {log.status === 'missing' ? (
        <div className="banner" data-testid="auto-checks-missing">
          No automatic check has run yet. Checks run every {VERIFY.EVERY_HOURS} hours as part of the hourly census (or by hand: Actions → verify → Run workflow); results appear here.
        </div>
      ) : null}
      {log.status === 'error' ? <div className="banner red">Couldn't load the check log ({log.message}). Nothing is shown rather than a guess.</div> : null}
      {log.status === 'ok' ? (
        <>
          <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>
            Real wallets read with this site's own readers, then compared with sources Phrourax does not read from: Tydro's AaveProtocolDataProvider (balances and a recomputed
            health factor, same block) and Nado's Clearinghouse (every subaccount's maintenance health). Nado's official API is compared too, as a third source; when it refuses (it sits behind a Cloudflare check) the row says SOURCE UNAVAILABLE, which never counts as a pass. A case with no suitable wallet that run says NOT CHECKED. These are not the by-hand matches against the official apps further down.
          </div>
          <div className="table-wrap">
            <table className="t" data-testid="auto-checks-latest">
              <thead>
                <tr><th>Status</th><th>Case</th><th>Compared with</th><th>Latest</th><th>Fields</th><th>Versions</th></tr>
              </thead>
              <tbody>
                {latestChecks(log.records, now).map((g) => {
                  const r = g.latest;
                  const key = `${g.venue}${g.sourceType}${g.case}`;
                  if (!r) {
                    // an expected check with no record yet: shown, never left out
                    return (
                      <tr key={key} data-testid="auto-check-row" data-display={g.display}>
                        <td className="mono"><b style={{ color: DISPLAY_TONE[g.display] }}>{g.display}</b></td>
                        <td>{g.case}</td>
                        <td className="mono" style={{ fontSize: 11 }}>{SOURCE_TYPE[g.sourceType] ?? g.sourceType}</td>
                        <td className="mono" style={{ fontSize: 11 }}><div className="neg">no check has run for this yet</div></td>
                        <td className="num">—</td>
                        <td className="mono" style={{ fontSize: 11 }}>—</td>
                      </tr>
                    );
                  }
                  const passed = r.fields.filter((f) => f.pass === true).length;
                  return (
                    <tr key={key} data-testid="auto-check-row" data-display={g.display}>
                      <td className="mono"><b style={{ color: DISPLAY_TONE[g.display] }}>{g.display}</b></td>
                      <td>{g.case}<div className="faint mono" style={{ fontSize: 11 }}>{r.wallet}</div></td>
                      <td className="mono" style={{ fontSize: 11 }}>{SOURCE_TYPE[r.sourceType] ?? r.sourceType}<div className="faint">{r.source}</div></td>
                      <td className="mono" style={{ fontSize: 11 }}>
                        {fmtAge(Date.parse(r.at), now)} ago{r.block !== null ? ` · block ${r.block.toLocaleString('en-US')}` : ''}
                        {r.failureReason ? <div className="neg">{brandText(r.failureReason)}</div> : null}
                        {g.display !== 'CURRENT' && g.lastSuccess && g.lastSuccess !== r ? (
                          <div className="faint">last success {fmtAge(Date.parse(g.lastSuccess.at), now)} ago ({g.lastSuccessDisplay})</div>
                        ) : null}
                      </td>
                      <td className="num">{r.fields.length ? `${passed}/${r.fields.length}` : '—'}</td>
                      <td className="mono" style={{ fontSize: 11 }}>
                        rules {r.rulesVersion}{r.rulesVersion !== RULES.RULES_VERSION ? <b className="proof-old"> (older)</b> : null}
                        {r.engineVersion ? ` · ${r.engineVersion}` : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <details style={{ marginTop: 10 }}>
            <summary className="mono dim" style={{ fontSize: 11, cursor: 'pointer' }}>History ({log.records.length} records, newest first — never deleted)</summary>
            <ul className="reasons" style={{ marginTop: 8 }}>
              {[...log.records].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 60).map((r, i) => (
                <li key={`${r.at}${i}`}>
                  {r.status.replace('_', ' ')} · {r.venue} · {caseName(r.case)} · {r.wallet} · {SOURCE_TYPE[r.sourceType] ?? r.sourceType} · {r.at} · block {r.block ?? '—'} · rules {r.rulesVersion}
                  {r.fields.length ? ` · ${r.fields.map((f) => `${f.label} ${f.pass === null ? 'n/a' : f.pass ? 'ok' : `FAIL (Phrourax ${f.aegis}, source ${f.expected}, ±${f.tolerance})`}`).join('; ')}` : ''}
                  {r.failureReason ? ` · ${brandText(r.failureReason)}` : ''}
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : null}
    </Panel>
  );
}
