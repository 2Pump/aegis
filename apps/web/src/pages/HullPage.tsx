import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { parseAddress } from '@aegis/ink-io';
import { classify } from '@aegis/pose';
import { HullPlate } from '../components/HullPlate';
import { WalletHistory } from '../components/WalletHistory';
import { PasteBar } from '../components/PasteBar';
import { FIXTURES, FIXTURE_NAMES } from '../lib/fixtures';
import { useLiveHull, useNow, type ReadProgress } from '../lib/hulls';
import { remember } from '../lib/recent';
import { usePlanGate } from '../lib/account';

export function HullPage() {
  const { address = '' } = useParams();
  const parsed = useMemo(() => parseAddress(address), [address]);
  const addr = parsed.ok ? parsed.value.lower : null;
  useMemo(() => addr && remember(addr), [addr]);
  const { state, loading, progress, nextInMs, refresh } = useLiveHull(addr);
  const now = useNow();
  const gate = usePlanGate();

  if (!parsed.ok) {
    return (
      <div className="stack">
        <div className="banner red" data-testid="bad-address">Not a readable address: {parsed.error.message}</div>
        <PasteBar autoFocus />
      </div>
    );
  }
  if (!state) {
    return (
      <div className="stack">
        <h2 className="page">Wallet {parsed.value.checksum}</h2>
        <div className="banner cyan" data-testid="hull-loading">Reading the wallet… Tydro and Nado, both straight from the Ink chain.</div>
        <ReadProgressPanel progress={progress} now={now} />
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 16 }}>
      <HullPlate
        book={state.book}
        pose={state.pose}
        lastOk={state.lastOk}
        firstSeen={state.firstSeen}
        now={now}
        loading={loading}
        nextInMs={nextInMs}
        onRefresh={refresh}
      />
      {/* real wallets only — test wallets (FixturePage) never get a history */}
      {gate === 'open' ? <WalletHistory address={parsed.value.lower} /> : null}
    </div>
  );
}

export function FixturePage() {
  const { name = '' } = useParams();
  const book = FIXTURES[name];
  const now = useNow();
  const pose = useMemo(() => (book ? classify(book) : null), [book]);
  if (!book || !pose) {
    return <div className="banner red">Unknown test wallet “{name}”. Known: {FIXTURE_NAMES.join(', ')}</div>;
  }
  return (
    <HullPlate
      book={book}
      pose={pose}
      lastOk={{ tydro: book.tydro.status === 'OK' ? book.asOfTime : null, nado: book.nado.status === 'OK' ? book.asOfTime : null }}
      firstSeen={book.asOfTime}
      now={now}
    />
  );
}

const PHASE: Record<ReadProgress['tydro'], string> = {
  waiting: 'WAITING',
  lookup: 'FINDING SUBACCOUNTS',
  reading: 'READING',
  ok: 'READ',
  failed: "COULDN'T READ",
};

/**
 * What the read is doing right now — from the reader's own callbacks, never a timed animation. Stage changes are
 * announced politely; the seconds counter isn't (it would spam screen readers).
 */
function ReadProgressPanel({ progress, now }: { progress: ReadProgress | null; now: number }) {
  const both = progress && progress.tydro !== 'waiting' && progress.nado !== 'waiting' && ['ok', 'failed'].includes(progress.tydro) && ['ok', 'failed'].includes(progress.nado);
  const anyOk = progress?.tydro === 'ok' || progress?.nado === 'ok';
  const rows: Array<[string, string, string]> = [
    ['Ink RPC', anyOk ? 'ANSWERING' : both ? 'NO GOOD ANSWER' : 'CONNECTING', 'every number comes from view calls on chain 57073'],
    ['Tydro', progress ? PHASE[progress.tydro] : 'WAITING', 'lending positions and health factor'],
    ['Nado', progress ? PHASE[progress.nado] : 'WAITING', progress?.nado === 'lookup' ? "looking up this owner's subaccounts first" : 'margin account, spot and perp positions'],
    ['Result', both ? 'PREPARING' : 'WAITING FOR BOTH VENUES', 'position type and risk, by the published rules'],
  ];
  return (
    <section className="panel read-progress" style={{ ['--rail' as string]: 'var(--cyan)' }} data-testid="read-progress">
      <div className="rail" aria-hidden />
      <div className="body">
        <h3 className="panel-title">
          Reading
          <span className="right mono" aria-hidden>{progress ? `${Math.max(0, Math.floor((now - progress.startedAt) / 1000))}s` : '—'}</span>
        </h3>
        <dl className="kv" aria-live="polite">
          {rows.map(([k, v, why]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd>
                <span className={`mono rp-${v === 'READ' || v === 'ANSWERING' ? 'ok' : v === "COULDN'T READ" || v === 'NO GOOD ANSWER' ? 'bad' : 'wait'}`}>{v}</span> <span className="faint">· {why}</span>
              </dd>
            </div>
          ))}
        </dl>
        <div className="faint mono" style={{ fontSize: 11, marginTop: 8 }}>Most reads complete within 5–15 seconds. A venue that can't be read is shown as such — never filled in.</div>
      </div>
    </section>
  );
}
