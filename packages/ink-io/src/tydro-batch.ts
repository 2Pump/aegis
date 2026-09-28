import { familyOf, type Leg, type TydroBook } from '@aegis/pose';
import type { PublicClient } from 'viem';
import { multicallAdaptive, type Call } from './batch.js';
import { TYDRO_TOKENS } from './logs.js';
import { Err, Ok, errMessage, type InkError, type Result } from './result.js';
import { TYDRO, TYDRO_RESERVES } from './tydro-registry.js';

/**
 * Tydro for many wallets at one block. Same sources as the single-hull reader (tydro.ts):
 * Pool.getUserAccountData for HF/totals, aToken/vToken balanceOf for legs, AaveOracle for prices.
 * `tokens` narrows which of the 28 tokens to read per wallet (from discovery); missing → read all.
 */
const poolAbi = [
  {
    type: 'function',
    name: 'getUserAccountData',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'totalCollateralBase', type: 'uint256' },
      { name: 'totalDebtBase', type: 'uint256' },
      { name: 'availableBorrowsBase', type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'healthFactor', type: 'uint256' },
    ],
  },
] as const;
const oracleAbi = [
  { type: 'function', name: 'BASE_CURRENCY_UNIT', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getAssetsPrices', stateMutability: 'view', inputs: [{ name: 'assets', type: 'address[]' }], outputs: [{ type: 'uint256[]' }] },
] as const;
const balAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export interface TydroPrices {
  /** USD per whole token, index = reserve index */
  usd: number[];
  /** AaveOracle BASE_CURRENCY_UNIT (1e8 for USD on Aave v3) */
  baseUnit: number;
}

export async function readTydroPrices(client: PublicClient, blockNumber: bigint): Promise<Result<TydroPrices>> {
  try {
    const [unit, prices] = await Promise.all([
      client.readContract({ address: TYDRO.ORACLE, abi: oracleAbi, functionName: 'BASE_CURRENCY_UNIT', blockNumber }),
      client.readContract({ address: TYDRO.ORACLE, abi: oracleAbi, functionName: 'getAssetsPrices', args: [TYDRO_RESERVES.map((r) => r.underlying)], blockNumber }),
    ]);
    const u = Number(unit);
    return Ok({ usd: prices.map((p) => Number(p) / u), baseUnit: u });
  } catch (e) {
    return Err('RPC_DEAD', `Tydro oracle: ${errMessage(e)}`);
  }
}

export type TydroMany = Map<string, Result<TydroBook>>;

export async function readTydroMany(
  client: PublicClient,
  users: readonly string[],
  blockNumber: bigint,
  opts: { tokens?: ReadonlyMap<string, ReadonlySet<number>>; prices?: TydroPrices; chunk?: number; onChunk?: (d: number, t: number) => void } = {},
): Promise<Result<TydroMany>> {
  let prices = opts.prices;
  if (!prices) {
    const p = await readTydroPrices(client, blockNumber);
    if (!p.ok) return p;
    prices = p.value;
  }

  // 1) account data for everyone
  const acctCalls: Call[] = users.map((u) => ({ address: TYDRO.POOL, abi: poolAbi, functionName: 'getUserAccountData', args: [u] }));
  // 2) balances only for the tokens each user touched
  const balIndex: Array<[number, number]> = []; // [userIdx, tokenIdx]
  const balCalls: Call[] = [];
  users.forEach((u, ui) => {
    const set = opts.tokens?.get(u.toLowerCase());
    const idxs = set && set.size ? [...set] : TYDRO_TOKENS.map((_, i) => i);
    for (const ti of idxs) {
      balIndex.push([ui, ti]);
      balCalls.push({ address: TYDRO_TOKENS[ti]!, abi: balAbi, functionName: 'balanceOf', args: [u] });
    }
  });

  const total = acctCalls.length + balCalls.length;
  const [acct, bals] = await Promise.all([
    multicallAdaptive(client, acctCalls, { blockNumber, chunk: opts.chunk ?? 300, onChunk: (d) => opts.onChunk?.(d, total) }),
    multicallAdaptive(client, balCalls, { blockNumber, chunk: opts.chunk ?? 500 }),
  ]);

  const perUser: Array<{ sup: Leg[]; debt: Leg[]; err: string | null }> = users.map(() => ({ sup: [], debt: [], err: null }));
  bals.forEach((r, k) => {
    const [ui, ti] = balIndex[k]!;
    const slot = perUser[ui]!;
    if (!r.ok) {
      slot.err = r.error;
      return;
    }
    const reserve = TYDRO_RESERVES[Math.floor(ti / 2)]!;
    const amount = Number(r.value as bigint) / 10 ** reserve.decimals;
    if (amount <= 0) return;
    const price = prices!.usd[Math.floor(ti / 2)] ?? 0;
    const symbol = reserve.symbol === 'USDT' ? 'USDT0' : reserve.symbol;
    const { family, assetClass } = familyOf(reserve.symbol);
    const leg: Leg = { symbol, family, assetClass, amount, usd: amount * price, priceUsd: price, priceSource: 'TYDRO_ORACLE' };
    (ti % 2 === 0 ? slot.sup : slot.debt).push(leg);
  });

  const out: TydroMany = new Map();
  users.forEach((u, ui) => {
    const a = acct[ui]!;
    const slot = perUser[ui]!;
    if (!a.ok) return void out.set(u.toLowerCase(), { ok: false, error: { code: 'PARSE_FAIL', message: `getUserAccountData: ${a.error}` } satisfies InkError });
    if (slot.err) return void out.set(u.toLowerCase(), { ok: false, error: { code: 'PARSE_FAIL', message: `balanceOf: ${slot.err}` } });
    const [coll, debt, , lt, , hf] = a.value as readonly bigint[];
    const unit = prices!.baseUnit;
    const supUsd = slot.sup.reduce((s, l) => s + l.usd, 0);
    const debtUsd = slot.debt.reduce((s, l) => s + l.usd, 0);
    out.set(
      u.toLowerCase(),
      Ok({
        hf: debt === 0n ? null : Number(hf) / 1e18,
        supplies: slot.sup,
        debts: slot.debt,
        totalCollateralUsd: Number(coll) / unit,
        totalDebtUsd: Number(debt) / unit,
        usdNet: supUsd - debtUsd,
        liquidationThreshold: lt && lt > 0n ? Number(lt) / 10_000 : null,
        notes: [],
      }),
    );
  });

  // Cross-check: Pool totals are the truth. If the legs we read (only the tokens discovery saw this wallet touch)
  // don't add up to them, the token list was incomplete — re-read that wallet with all 28 tokens.
  if (opts.tokens) {
    const redo: string[] = [];
    for (const [u, r] of out) {
      if (!r.ok || !opts.tokens.get(u)?.size) continue;
      const b = r.value;
      const legDebt = b.debts.reduce((x, l) => x + l.usd, 0);
      const legSup = b.supplies.reduce((x, l) => x + l.usd, 0);
      const debtOff = Math.abs(legDebt - b.totalDebtUsd) > Math.max(1, b.totalDebtUsd * 0.01);
      const supShort = legSup < b.totalCollateralUsd * 0.99 - 1; // supplies can exceed collateral (non-collateral supply), never fall short
      if (debtOff || supShort) redo.push(u);
    }
    if (redo.length) {
      const again = await readTydroMany(client, redo, blockNumber, { prices, chunk: opts.chunk });
      if (again.ok) {
        for (const [u, r] of again.value) {
          if (r.ok) r.value.notes.push('re-read with all Tydro tokens (discovery had not seen every token this wallet holds)');
          out.set(u, r);
        }
      }
    }
  }
  return Ok(out);
}
