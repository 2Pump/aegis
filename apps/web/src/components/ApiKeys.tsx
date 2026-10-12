/**
 * Account → API keys (Desk). A key is shown once, when it's made; afterwards only its name and last 4 characters.
 * Revoking stops it within about 30 seconds.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Panel } from './bits';
import { authPost, fmtDay } from '../lib/account';

interface KeyView {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
}
interface KeysState {
  desk: boolean;
  max: number;
  keys: KeyView[];
}

export function ApiKeys() {
  const [s, setS] = useState<KeysState | null>(null);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/v1/keys', { credentials: 'same-origin', cache: 'no-store' });
      if (r.ok && (r.headers.get('content-type') ?? '').includes('json')) setS((await r.json()) as KeysState);
    } catch {
      /* the panel stays hidden */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!s) return null;

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const r = await authPost<KeysState & { key: string }>('keys', { name }, '').catch(() => null);
    setBusy(false);
    if (!r) return;
    if (!r.ok) return setErr(r.message);
    setFresh(r.data.key);
    setCopied(false);
    setName('');
    setS((x) => (x ? { ...x, keys: r.data.keys } : x));
  };
  const revoke = async (id: string) => {
    setBusy(true);
    setErr(null);
    const r = await authPost<KeysState>('keys/revoke', { id }, '');
    setBusy(false);
    if (!r.ok) return setErr(r.message);
    setS((x) => (x ? { ...x, keys: r.data.keys } : x));
  };
  const copy = async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Panel title="API keys" rail={s.desk ? 'var(--cyan)' : 'var(--slate)'} testId="api-keys" right={<span className="mono">{s.keys.length} / {s.max}</span>}>
      {!s.desk ? (
        <p className="dim" style={{ margin: 0 }} data-testid="api-keys-locked">
          API keys come with the <Link to="/pricing">Desk plan</Link>.{s.keys.length ? ' Your existing keys are kept but answer 402 until Desk is active again.' : ''}
        </p>
      ) : null}
      {fresh ? (
        <div className="key-fresh" data-testid="api-key-fresh">
          <div className="faint mono" style={{ fontSize: 11, letterSpacing: '0.1em' }}>YOUR NEW KEY — SHOWN ONCE</div>
          <code className="key-value" data-testid="api-key-value">{fresh}</code>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="pill-btn solid" onClick={() => void copy()} data-testid="api-key-copy">{copied ? 'Copied' : 'Copy'}</button>
            <button className="pill-btn" onClick={() => setFresh(null)} data-testid="api-key-done">I&apos;ve saved it</button>
          </div>
          <p className="dim" style={{ margin: 0, fontSize: 12.5 }}>Phrourax keeps only a fingerprint of it and can&apos;t show it again. Keep it out of websites and public code.</p>
        </div>
      ) : null}
      {s.keys.length ? (
        <div className="table-wrap">
          <table className="t" data-testid="api-keys-table">
            <thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th /></tr></thead>
            <tbody>
              {s.keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td className="mono">phx_…{k.hint}</td>
                  <td className="mono">{fmtDay(k.createdAt)}</td>
                  <td className="mono">{k.lastUsedAt ? fmtDay(k.lastUsedAt) : 'never'}</td>
                  <td className="r"><button className="pill-btn" disabled={busy} onClick={() => void revoke(k.id)} data-testid="api-key-revoke">Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : s.desk ? <p className="dim" style={{ margin: 0 }}>No keys yet.</p> : null}
      {s.desk && s.keys.length < s.max && !fresh ? (
        <form className="auth-form" onSubmit={(e) => void create(e)} style={{ marginTop: 12 }}>
          <label className="sr-only" htmlFor="api-key-name">Key name</label>
          <input id="api-key-name" placeholder="Name, e.g. trading-bot" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} data-testid="api-key-name" />
          <button className="pill-btn solid" type="submit" disabled={busy} data-testid="api-key-create">Create key</button>
        </form>
      ) : null}
      {err ? <div className="auth-error" role="alert" style={{ marginTop: 8 }}>{err}</div> : null}
      {s.desk ? (
        <p className="faint" style={{ margin: '12px 0 0', fontSize: 12.5 }}>
          Send it as <span className="mono">Authorization: Bearer phx_…</span>. Rate limits then count per key. See <Link to="/developers">Developers</Link>.
        </p>
      ) : null}
    </Panel>
  );
}
