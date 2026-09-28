import type { Book } from '@aegis/pose';
import carry from '../../../../fixtures/carry.json';
import naked from '../../../../fixtures/naked.json';
import equityMargin from '../../../../fixtures/equity-margin.json';
import wounded from '../../../../fixtures/wounded.json';
import dark from '../../../../fixtures/dark.json';
import empty from '../../../../fixtures/empty.json';

/** Synthetic books from /fixtures — the six dossier examples. Never shown as real accounts. */
export const FIXTURES: Record<string, Book> = {
  carry: carry as unknown as Book,
  naked: naked as unknown as Book,
  'equity-margin': equityMargin as unknown as Book,
  wounded: wounded as unknown as Book,
  dark: dark as unknown as Book,
  empty: empty as unknown as Book,
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);
