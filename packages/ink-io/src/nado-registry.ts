// Nado on-chain registry.
// Contracts: nadohq/nado-typescript-sdk @ 7a326cb (2026-09-25), packages/shared/src/deployments/core/deployment.inkMainnet.json
//   Verified on Blockscout 2026-09-28: querier → FQuerier impl 0xd0d3…d386, clearinghouse → Clearinghouse impl 0x1960…6610,
//   both created by Nado deployer 0xC1cC56caB60e832665E6c3780BfEBe3C1C971603.
// ABI: getSubaccountInfo copied verbatim from the same SDK commit (packages/shared/src/abis/Querier.ts).
// Products: Nado gateway `symbols` snapshot 2026-09-28. Unknown product ids render as SPOT#n / PERP#n and never hedge anything.
// Product 11 is the NLP vault share (Nado Liquidity Provider): `NLP_PRODUCT_ID = 11` in nadohq/nado-typescript-sdk @ aa288c6
//   (2026-10-01), packages/shared/src/consts/productIds.ts. It is not in the gateway `symbols` list, so it used to show as SPOT#11.
//   Naming it changes nothing in classification: like any unlisted spot it is its own family and never hedges a perp.
import type { Abi, Address } from 'viem';

export const NADO_SDK_COMMIT = '7a326cb';
export const NADO_PRODUCTS_FETCHED = '2026-09-28';

export const NADO_CONTRACTS = {
  querier: '0x68798229F88251b31D534733D6C4098318c9dff8',
  clearinghouse: '0xD218103918C19D0A10cf35300E4CfAfbD444c5fE',
  endpoint: '0x05ec92D78ED421f3D3Ada77FFdE167106565974E',
  spotEngine: '0xFcD94770B95fd9Cc67143132BB172EB17A0907fE',
  perpEngine: '0xF8599D58d1137fC56EcDd9C16ee139C8BDf96da1',
  quote: '0x0200C29006150606B650577BBE7B6248F58470c1',
} as const satisfies Record<string, Address>;

export const QUERIER_GET_SUBACCOUNT_INFO_ABI = [{"inputs":[{"internalType":"bytes32","name":"subaccount","type":"bytes32"}],"name":"getSubaccountInfo","outputs":[{"components":[{"internalType":"bytes32","name":"subaccount","type":"bytes32"},{"internalType":"bool","name":"exists","type":"bool"},{"components":[{"internalType":"int128","name":"assets","type":"int128"},{"internalType":"int128","name":"liabilities","type":"int128"},{"internalType":"int128","name":"health","type":"int128"}],"internalType":"struct FQuerier.HealthInfo[]","name":"healths","type":"tuple[]"},{"internalType":"int128[][]","name":"healthContributions","type":"int128[][]"},{"internalType":"uint32","name":"spotCount","type":"uint32"},{"internalType":"uint32","name":"perpCount","type":"uint32"},{"components":[{"internalType":"uint32","name":"productId","type":"uint32"},{"components":[{"internalType":"int128","name":"amount","type":"int128"}],"internalType":"struct ISpotEngine.Balance","name":"balance","type":"tuple"}],"internalType":"struct FQuerier.SpotBalance[]","name":"spotBalances","type":"tuple[]"},{"components":[{"internalType":"uint32","name":"productId","type":"uint32"},{"components":[{"internalType":"int128","name":"amount","type":"int128"},{"internalType":"int128","name":"vQuoteBalance","type":"int128"},{"internalType":"int128","name":"lastCumulativeFundingX18","type":"int128"}],"internalType":"struct IPerpEngine.Balance","name":"balance","type":"tuple"}],"internalType":"struct FQuerier.PerpBalance[]","name":"perpBalances","type":"tuple[]"},{"components":[{"internalType":"uint32","name":"productId","type":"uint32"},{"internalType":"int128","name":"oraclePriceX18","type":"int128"},{"components":[{"internalType":"int128","name":"longWeightInitialX18","type":"int128"},{"internalType":"int128","name":"shortWeightInitialX18","type":"int128"},{"internalType":"int128","name":"longWeightMaintenanceX18","type":"int128"},{"internalType":"int128","name":"shortWeightMaintenanceX18","type":"int128"},{"internalType":"int128","name":"priceX18","type":"int128"}],"internalType":"struct RiskHelper.Risk","name":"risk","type":"tuple"},{"components":[{"internalType":"address","name":"token","type":"address"},{"internalType":"int128","name":"interestInflectionUtilX18","type":"int128"},{"internalType":"int128","name":"interestFloorX18","type":"int128"},{"internalType":"int128","name":"interestSmallCapX18","type":"int128"},{"internalType":"int128","name":"interestLargeCapX18","type":"int128"},{"internalType":"int128","name":"withdrawFeeX18","type":"int128"},{"internalType":"int128","name":"minDepositRateX18","type":"int128"}],"internalType":"struct ISpotEngine.Config","name":"config","type":"tuple"},{"components":[{"internalType":"int128","name":"cumulativeDepositsMultiplierX18","type":"int128"},{"internalType":"int128","name":"cumulativeBorrowsMultiplierX18","type":"int128"},{"internalType":"int128","name":"totalDepositsNormalized","type":"int128"},{"internalType":"int128","name":"totalBorrowsNormalized","type":"int128"}],"internalType":"struct ISpotEngine.State","name":"state","type":"tuple"},{"components":[{"internalType":"int128","name":"sizeIncrement","type":"int128"},{"internalType":"int128","name":"priceIncrementX18","type":"int128"},{"internalType":"int128","name":"minSize","type":"int128"},{"internalType":"int128","name":"collectedFees","type":"int128"}],"internalType":"struct FQuerier.BookInfo","name":"bookInfo","type":"tuple"}],"internalType":"struct FQuerier.SpotProduct[]","name":"spotProducts","type":"tuple[]"},{"components":[{"internalType":"uint32","name":"productId","type":"uint32"},{"internalType":"int128","name":"oraclePriceX18","type":"int128"},{"components":[{"internalType":"int128","name":"longWeightInitialX18","type":"int128"},{"internalType":"int128","name":"shortWeightInitialX18","type":"int128"},{"internalType":"int128","name":"longWeightMaintenanceX18","type":"int128"},{"internalType":"int128","name":"shortWeightMaintenanceX18","type":"int128"},{"internalType":"int128","name":"priceX18","type":"int128"}],"internalType":"struct RiskHelper.Risk","name":"risk","type":"tuple"},{"components":[{"internalType":"int128","name":"cumulativeFundingLongX18","type":"int128"},{"internalType":"int128","name":"cumulativeFundingShortX18","type":"int128"},{"internalType":"int128","name":"availableSettle","type":"int128"},{"internalType":"int128","name":"openInterest","type":"int128"}],"internalType":"struct IPerpEngine.State","name":"state","type":"tuple"},{"components":[{"internalType":"int128","name":"sizeIncrement","type":"int128"},{"internalType":"int128","name":"priceIncrementX18","type":"int128"},{"internalType":"int128","name":"minSize","type":"int128"},{"internalType":"int128","name":"collectedFees","type":"int128"}],"internalType":"struct FQuerier.BookInfo","name":"bookInfo","type":"tuple"}],"internalType":"struct FQuerier.PerpProduct[]","name":"perpProducts","type":"tuple[]"}],"internalType":"struct FQuerier.SubaccountInfo","name":"","type":"tuple"}],"stateMutability":"view","type":"function"}] as const satisfies Abi;

type P = readonly [number, string, 'spot' | 'perp'];
const RAW: readonly P[] = [
  [0, 'USDT0', 'spot'], [1, 'KBTC', 'spot'], [2, 'BTC-PERP', 'perp'], [3, 'WETH', 'spot'], [4, 'ETH-PERP', 'perp'],
  [5, 'USDC', 'spot'], [8, 'SOL-PERP', 'perp'], [11, 'NLP', 'spot'], [10, 'XRP-PERP', 'perp'], [14, 'BNB-PERP', 'perp'], [16, 'HYPE-PERP', 'perp'],
  [18, 'ZEC-PERP', 'perp'], [20, 'MON-PERP', 'perp'], [22, 'FARTCOIN-PERP', 'perp'], [24, 'SUI-PERP', 'perp'], [26, 'AAVE-PERP', 'perp'],
  [28, 'XAUT-PERP', 'perp'], [30, 'PUMP-PERP', 'perp'], [32, 'TAO-PERP', 'perp'], [34, 'XMR-PERP', 'perp'], [36, 'LIT-PERP', 'perp'],
  [38, 'kPEPE-PERP', 'perp'], [40, 'PENGU-PERP', 'perp'], [42, 'USELESS-PERP', 'perp'], [44, 'SKR-PERP', 'perp'], [46, 'UNI-PERP', 'perp'],
  [48, 'ASTER-PERP', 'perp'], [50, 'XPL-PERP', 'perp'], [52, 'DOGE-PERP', 'perp'], [54, 'WLFI-PERP', 'perp'], [56, 'kBONK-PERP', 'perp'],
  [58, 'ZRO-PERP', 'perp'], [60, 'ADA-PERP', 'perp'], [62, 'ARB-PERP', 'perp'], [64, 'AVAX-PERP', 'perp'], [66, 'AXS-PERP', 'perp'],
  [68, 'BCH-PERP', 'perp'], [70, 'BERA-PERP', 'perp'], [72, 'ENA-PERP', 'perp'], [74, 'LINK-PERP', 'perp'], [76, 'LTC-PERP', 'perp'],
  [78, 'NEAR-PERP', 'perp'], [80, 'ONDO-PERP', 'perp'], [82, 'SKY-PERP', 'perp'], [84, 'VIRTUAL-PERP', 'perp'], [86, 'JUP-PERP', 'perp'],
  [88, 'XAG-PERP', 'perp'], [90, 'WTI-PERP', 'perp'], [92, 'EURUSD-PERP', 'perp'], [94, 'GBPUSD-PERP', 'perp'], [96, 'USDJPY-PERP', 'perp'],
  [98, 'QQQ-PERP', 'perp'], [100, 'SPY-PERP', 'perp'], [102, 'AAPL-PERP', 'perp'], [104, 'AMZN-PERP', 'perp'], [106, 'GOOGL-PERP', 'perp'],
  [108, 'META-PERP', 'perp'], [110, 'MSFT-PERP', 'perp'], [112, 'NVDA-PERP', 'perp'], [114, 'TSLA-PERP', 'perp'], [115, 'wQQQx', 'spot'],
  [117, 'wSPYx', 'spot'], [120, 'MEGA-PERP', 'perp'], [122, 'TON-PERP', 'perp'], [124, 'VVV-PERP', 'perp'], [126, 'AMD-PERP', 'perp'],
  [128, 'AVGO-PERP', 'perp'], [130, 'DELL-PERP', 'perp'], [132, 'INTC-PERP', 'perp'], [134, 'MRVL-PERP', 'perp'], [136, 'MU-PERP', 'perp'],
  [138, 'SNDK-PERP', 'perp'], [140, 'SPCX-PERP', 'perp'], [142, 'WLD-PERP', 'perp'], [143, 'wAAPLx', 'spot'], [145, 'wAMZNx', 'spot'],
  [147, 'wGOOGLx', 'spot'], [149, 'wMETAx', 'spot'], [151, 'wMSFTx', 'spot'], [153, 'wNVDAx', 'spot'], [155, 'wTSLAx', 'spot'],
  [158, 'CHIP-PERP', 'perp'], [159, 'XAUT0', 'spot'], [162, 'PENG-PERP', 'perp'], [164, 'BBX-PERP', 'perp'], [166, 'MSTR-PERP', 'perp'],
  [168, 'ZHIPU-PERP', 'perp'], [170, 'CRCL-PERP', 'perp'], [172, 'EIGEN-PERP', 'perp'], [174, 'NBIS-PERP', 'perp'], [176, 'HIMS-PERP', 'perp'],
  [178, 'LLY-PERP', 'perp'], [180, 'ORCL-PERP', 'perp'], [182, 'SKHY-PERP', 'perp'], [184, 'ANSEM-PERP', 'perp'], [186, 'CASHCAT-PERP', 'perp'],
  [188, 'PONS-PERP', 'perp'],
];

/** The NLP vault share's spot product id (see the header). */
export const NLP_PRODUCT_ID = 11;

/**
 * Endpoint.getNlpPools(): the NLP vault's pool subaccounts (pool id, subaccount, owner, balance weight).
 * ABI copied verbatim from nadohq/nado-typescript-sdk @ aa288c6, packages/shared/src/abis/Endpoint.ts. A view call: read only.
 */
export const ENDPOINT_GET_NLP_POOLS_ABI = [{"inputs":[],"name":"getNlpPools","outputs":[{"components":[{"internalType":"uint64","name":"poolId","type":"uint64"},{"internalType":"bytes32","name":"subaccount","type":"bytes32"},{"internalType":"address","name":"owner","type":"address"},{"internalType":"uint128","name":"balanceWeightX18","type":"uint128"}],"internalType":"struct IEndpoint.NlpPool[]","name":"","type":"tuple[]"}],"stateMutability":"view","type":"function"}] as const satisfies Abi;

export const NADO_PRODUCTS: ReadonlyMap<number, { symbol: string; type: 'spot' | 'perp' }> = new Map(
  RAW.map(([id, symbol, type]) => [id, { symbol, type }]),
);
