import { Link } from 'react-router-dom';
import { RULES, classify } from '@aegis/pose';
import { RISK_LABEL } from '@aegis/glyphs';
import { Panel, TagChip } from '../components/bits';
import { FIXTURES } from '../lib/fixtures';
import { PROOFS, PROOF_STALE_DAYS, VENUE_VERIFIED, VERIFIED, proofStatus, verificationText } from '../lib/verification';

/** Synthetic books + proof status. Nothing on this page is a real account. */
export function CalibrationPage() {
  return (
    <div className="stack">
      <h2 className="page">Checks</h2>

      <Panel title="Are the readings right?" rail={VERIFIED ? 'var(--cyan)' : VENUE_VERIFIED.tydro || VENUE_VERIFIED.nado ? 'var(--amber)' : 'var(--red)'} testId="proof-panel">
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
