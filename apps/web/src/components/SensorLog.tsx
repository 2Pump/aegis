import { useLog } from '../lib/log';

export function SensorLog({ scope }: { scope?: string }) {
  const entries = useLog(scope);
  return (
    <div className="log" data-testid="sensor-log" aria-live="polite">
      {entries.length === 0 ? <div className="info">No reads yet.</div> : null}
      {entries.map((e, i) => (
        <div key={`${e.at}-${i}`} className={e.level}>
          {new Date(e.at).toISOString().slice(11, 19)} {e.scope === 'chain' ? '[chain] ' : ''}
          {e.msg}
        </div>
      ))}
    </div>
  );
}
