import { DEFINITIONS, PRIORITY_TEXT, RULE_TEXT, RULES } from '@aegis/pose';
import { RISK_LABEL, TAG_LABEL, TAG_MEANING } from '@aegis/glyphs';
import type { HullTemp, Tag } from '@aegis/pose';
import { TagChip } from './bits';

export function RulesContent() {
  return (
    <div className="stack">
      <p className="dim" style={{ margin: 0 }}>
        Rules {RULES.RULES_VERSION}. Built from the same constants the classifier runs on (<code>packages/pose/src/config.ts</code>).
        If the page and the code ever disagree, the test suite fails.
      </p>
      <div>
        {RULE_TEXT.map((r) => (
          <div className="rule-row" key={r.tag}>
            <div>
              <TagChip tag={r.tag} />
              <div className="faint mono" style={{ fontSize: 10, marginTop: 6, letterSpacing: '0.14em' }}>rule tag {r.tag} · {r.kind}</div>
            </div>
            <div>
              <div>{r.human}</div>
              <div className="pred">{r.predicate}</div>
            </div>
          </div>
        ))}
      </div>
      <p className="mono" style={{ fontSize: 12 }}>{PRIORITY_TEXT}</p>
      <h4 className="panel-title" style={{ marginTop: 8 }}>Names on this site</h4>
      <p className="dim" style={{ margin: 0 }}>
        The site shows plain names. The rules, the census file and share links keep the rule tags, so nothing changes underneath.
      </p>
      <div className="table-wrap">
        <table className="t" data-testid="display-names">
          <thead>
            <tr><th>Shown as</th><th>Rule tag</th><th>Meaning</th></tr>
          </thead>
          <tbody>
            {(Object.keys(TAG_LABEL) as Tag[]).map((t) => (
              <tr key={t}>
                <td>{TAG_LABEL[t]}</td>
                <td className="mono">{t}</td>
                <td className="dim">{TAG_MEANING[t]}</td>
              </tr>
            ))}
            {(Object.keys(RISK_LABEL) as HullTemp[]).map((t) => (
              <tr key={t}>
                <td>Risk: {RISK_LABEL[t]}</td>
                <td className="mono">{t}</td>
                <td className="dim">risk level (hull temp)</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4 className="panel-title" style={{ marginTop: 8 }}>Symbols</h4>
      <dl className="kv">
        {DEFINITIONS.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <h4 className="panel-title" style={{ marginTop: 8 }}>Constants</h4>
      <div className="table-wrap">
        <table className="t">
          <tbody>
            {Object.entries(RULES).map(([k, v]) => (
              <tr key={k}>
                <td className="mono">{k}</td>
                <td className="mono r">{String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
