import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { parseAddress } from '@aegis/ink-io';
import { classify } from '@aegis/pose';
import { HullPlate } from '../components/HullPlate';
import { WalletHistory } from '../components/WalletHistory';
import { PasteBar } from '../components/PasteBar';
import { FIXTURES, FIXTURE_NAMES } from '../lib/fixtures';
import { useLiveHull, useNow } from '../lib/hulls';
import { remember } from '../lib/recent';

export function HullPage() {
  const { address = '' } = useParams();
  const parsed = useMemo(() => parseAddress(address), [address]);
  const addr = parsed.ok ? parsed.value.lower : null;
  useMemo(() => addr && remember(addr), [addr]);
  const { state, loading, nextInMs, refresh } = useLiveHull(addr);
  const now = useNow();

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
      <WalletHistory address={parsed.value.lower} />
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
