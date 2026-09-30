import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { parseAddress } from '@aegis/ink-io';

export function PasteBar({ autoFocus = false }: { autoFocus?: boolean }) {
  const [v, setV] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();
  const go = () => {
    const r = parseAddress(v);
    if (!r.ok) {
      setErr(r.error.message);
      return;
    }
    setErr(null);
    nav(`/hull/${r.value.lower}`);
  };
  return (
    <form
      className="paste"
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
    >
      <label className="sr-only" htmlFor="addr">Ink address</label>
      <input
        id="addr"
        data-testid="paste-input"
        autoFocus={autoFocus}
        spellCheck={false}
        autoComplete="off"
        placeholder="Paste any Ink address — 0x…"
        value={v}
        onChange={(e) => setV(e.target.value)}
      />
      <button className="pill-btn amber" type="submit" data-testid="paste-go">Read wallet</button>
      {err ? <div className="err" role="alert" data-testid="paste-error">{err}</div> : null}
    </form>
  );
}
