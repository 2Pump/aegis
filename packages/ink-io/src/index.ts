export * from './result.js';
export { parseAddress, shortAddr, nadoSubaccount, subaccountKind, type ParsedAddress } from './address.js';
export { INK_CHAIN_ID, INK_DEFAULT_RPC, INK_EXPLORER, ink, makeInkClient, checkInkEndpoints, isZeroData, readHead, stableHead, type ChainHead } from './chain.js';
export { INK_PUBLIC_RPCS, splitRpcList, maskRpc, rotatingTransport, rotatingHttp, type RotateStats } from './rotate.js';
export { readTydro } from './tydro.js';
export { TYDRO, TYDRO_RESERVES, TYDRO_FETCHED, TYDRO_SOURCE } from './tydro-registry.js';
export {
  readNado,
  parseSubaccountInfo,
  parseSymbols,
  aggregate,
  x18,
  NADO_DIRECT,
  type NadoConfig,
  type SymbolMap,
} from './nado.js';
export { readBook, type BookRead, type ReadStage, type SensorsConfig } from './book.js';
export { readNadoChain, chainInfoToGatewayShape, RECENT_SUB_SCAN_MAX_BLOCKS, type NadoDiscovery } from './nado-chain.js';
export { NADO_CONTRACTS, NADO_PRODUCTS, NADO_SDK_COMMIT, NADO_PRODUCTS_FETCHED, NLP_PRODUCT_ID } from './nado-registry.js';
export { multicallAdaptive, type Call, type CallResult } from './batch.js';
export {
  TOPIC,
  TYDRO_START_BLOCK,
  NADO_START_BLOCK,
  TYDRO_TOKENS,
  scanLogs,
  scanTydro,
  scanNadoAccounts,
  scanNadoActivity,
  decodeTydroTransfers,
  decodeNadoSubaccounts,
  decodeNadoProtocolSubaccounts,
  isProtocolSub,
  scanNadoTouched,
  VERTEX_PROTOCOL_SUBS,
  subaccountOwner,
  type ScanResult,
  type ScanProgress,
} from './logs.js';
export { readTydroMany, readTydroPrices, type TydroPrices } from './tydro-batch.js';
export { nadoHealthMany, readNadoSubsMany, nadoBooksByOwner, readNlpPools, type NlpPool } from './nado-batch.js';
export { readBooksMany, type ReadManyInput, type ReadManyResult } from './books.js';
export { classifyRpcError, describeRpcError, type RpcErrorKind } from './rpc-errors.js';
export { seedTydroHolders, INK_EXPLORER_API, type SeedResult } from './explorer.js';
export { parseRangeLimit, getLearnedMaxSpan, resetLearnedMaxSpan } from './logs.js';
export type { FetchLike } from './http.js';
export { readProtocolTotals, type ProtocolTotals } from './totals.js';

/**
 * Versions of the readers and the price sources, stamped on every historical record so a past reading can be
 * audited against the code that made it. Bump on any change to what the readers return.
 */
export const READER_VERSION = 'ink-io-2026.10.04';
/** Tydro: AaveOracle via the pool's price oracle · Nado: oracle prices read on-chain through FQuerier */
export const PRICE_SOURCE_VERSION = 'tydro-aaveoracle+nado-fquerier-1';
export { LIQ_TOPIC, LIQ_SOURCES, decodeLiquidations, scanLiquidations, type RawLiquidation } from './liquidations.js';
export { PYTH, EIP1967_IMPL_SLOT, readOracleSnapshot, readProtocolParams, type OracleSnapshot, type AggregatorRead, type ParamRead, type ParamSnapshot } from './oracles.js';
export { readCarryPoint, blockAtTime, readGas, OP_GAS_PRICE_ORACLE, type GasRead, type CarryPoint, type TydroMarket, type NadoSpotMarket, type NadoPerpMarket } from './carry.js';
export { readNadoPerpRefs, parseMarketLiquidity, fetchNadoBook, type NadoPerpRef, type BookLevel, type NadoBookRead, type BookFetch } from './nado-depth.js';
