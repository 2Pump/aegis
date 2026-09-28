import { Link } from 'react-router-dom';
import { classify } from '@aegis/pose';
import { Panel, TagChip } from '../components/bits';
import { FIXTURES } from '../lib/fixtures';
import { PROOFS, VERIFIED } from '../lib/verification';

/** Synthetic books + proof status. Nothing on this page is a real account. */
export function CalibrationPage() {
  return (
    <div className="stack">
      <h2 className="page">Calibration</h2>

      <Panel title="Sensor proof" rail={VERIFIED ? 'var(--cyan)' : 'var(--red)'} testId="proof-panel">
        {VERIFIED ? (
          <ul className="reasons">
            {PROOFS.map((p) => (
              <li key={p.at}>PROVEN · {p.address} · block {p.block ?? '?'} · {p.fields} UI fields matched · rules {p.rulesVersion} · {p.at}</li>
            ))}
          </ul>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            <div className="banner red">UNVERIFIED — no real address has been matched against app.tydro.com / app.nado.xyz yet.</div>
            <div className="mono dim" style={{ fontSize: 12 }}>
              Run on your machine: <code>pnpm prove 0xYOUR_ADDRESS</code> — reads with the exact app sensors, cross-checks Tydro against the
              protocol data provider and Blockscout, then asks you for the official UI numbers.
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Fixture books — synthetic" rail="var(--slate)" right={<span className="mono">the six dossier examples</span>}>
        <div className="table-wrap">
          <table className="t" data-testid="fixture-list">
            <thead>
              <tr><th>Fixture</th><th>Tags</th><th>Temp</th></tr>
            </thead>
            <tbody>
              {Object.entries(FIXTURES).map(([name, b]) => {
                const p = classify(b);
                return (
                  <tr key={name}>
                    <td className="mono"><Link to={`/fixture/${name}`}>{b.label ?? name}</Link><span className="src">FIXTURE</span></td>
                    <td><div className="tags">{p.tags.map((t) => <TagChip key={t} tag={t} />)}</div></td>
                    <td className="mono">{p.hullTemp}</td>
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
