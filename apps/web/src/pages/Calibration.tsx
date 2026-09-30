import { Link } from 'react-router-dom';
import { classify } from '@aegis/pose';
import { RISK_LABEL } from '@aegis/glyphs';
import { Panel, TagChip } from '../components/bits';
import { FIXTURES } from '../lib/fixtures';
import { PROOFS, VENUE_VERIFIED, VERIFIED, verificationText } from '../lib/verification';

/** Synthetic books + proof status. Nothing on this page is a real account. */
export function CalibrationPage() {
  return (
    <div className="stack">
      <h2 className="page">Checks</h2>

      <Panel title="Are the readings right?" rail={VERIFIED ? 'var(--cyan)' : VENUE_VERIFIED.tydro || VENUE_VERIFIED.nado ? 'var(--amber)' : 'var(--red)'} testId="proof-panel">
        {VERIFIED || VENUE_VERIFIED.tydro || VENUE_VERIFIED.nado ? (
          <div className="stack" style={{ gap: 8 }}>
            <div className={`banner${VERIFIED ? ' cyan' : ''}`}>{VERIFIED ? 'CHECKED' : 'PARTLY CHECKED'} — {verificationText()}.</div>
            <ul className="reasons">
              {PROOFS.map((p) => (
                <li key={p.at}>
                  MATCHED · {(p.venues ?? ['tydro', 'nado']).join(' + ')} · {p.address} · block {p.block ?? '?'} · {p.fields} UI fields matched · rules {p.rulesVersion} · {p.at}
                </li>
              ))}
            </ul>
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
