import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER, applyFilter, filterFromParams, filterToParams, type FilterableShip } from './wellFilter';

const ship = (address: string, primary: FilterableShip['primary'], extra: Partial<FilterableShip> = {}): FilterableShip => ({
  address,
  primary,
  tags: primary ? [primary] : [],
  band: '1–10k',
  venues: { tydro: true, nado: false },
  ...extra,
});

const fleet: FilterableShip[] = [
  ship('0x1', 'CARRY', { venues: { tydro: true, nado: true }, band: '100k+' }),
  ship('0x2', 'NAKED', { venues: { tydro: false, nado: true }, tags: ['NAKED', 'WOUNDED'], band: '<1k' }),
  ship('0x3', 'LOCKED', { band: 'dust' }),
  ship('0x4', null, { venues: { tydro: false, nado: true } }),
  ship('0x5', 'HOLD', { venues: undefined }), // a hull opened this session: venue unknown
];

describe('well filters', () => {
  it('no filter → everyone', () => expect(applyFilter(fleet, EMPTY_FILTER)).toHaveLength(5));

  it('pose chips, including NO RULE', () => {
    expect(applyFilter(fleet, { ...EMPTY_FILTER, poses: ['CARRY', 'NAKED'] }).map((s) => s.address)).toEqual(['0x1', '0x2']);
    expect(applyFilter(fleet, { ...EMPTY_FILTER, poses: ['NONE'] }).map((s) => s.address)).toEqual(['0x4']);
  });

  it('wounded only uses the tag, not the primary', () => {
    expect(applyFilter(fleet, { ...EMPTY_FILTER, woundedOnly: true }).map((s) => s.address)).toEqual(['0x2']);
  });

  it('minimum size band hides dust and small books', () => {
    expect(applyFilter(fleet, { ...EMPTY_FILTER, min: '1k' }).map((s) => s.address)).toEqual(['0x1', '0x4', '0x5']);
    expect(applyFilter(fleet, { ...EMPTY_FILTER, min: '100k' }).map((s) => s.address)).toEqual(['0x1']);
  });

  it('venue filter; ships with unknown venue only show under "all"', () => {
    expect(applyFilter(fleet, { ...EMPTY_FILTER, venue: 'nado' }).map((s) => s.address)).toEqual(['0x1', '0x2', '0x4']);
    expect(applyFilter(fleet, { ...EMPTY_FILTER, venue: 'both' }).map((s) => s.address)).toEqual(['0x1']);
    expect(applyFilter(fleet, { ...EMPTY_FILTER, venue: 'tydro' }).map((s) => s.address)).toEqual(['0x1', '0x3']);
  });

  it('round-trips through the URL and ignores junk', () => {
    const f = { poses: ['CARRY', 'NONE'] as const, venue: 'nado' as const, min: '10k' as const, woundedOnly: true, find: '0x0b3fadef84ea8877ca3c898133b4056950b75ec5' };
    const back = filterFromParams(new URLSearchParams(filterToParams({ ...f, poses: [...f.poses] })));
    expect(back).toEqual({ ...f, poses: ['CARRY', 'NONE'] });
    const junk = filterFromParams(new URLSearchParams('pose=HACK,carry&venue=moon&min=5&wounded=yes&find=0x123'));
    expect(junk).toEqual({ ...EMPTY_FILTER, poses: ['CARRY'] });
  });
});
