import { makeInkClient, readBook, readHead, type BookRead, type ChainHead, type NadoConfig, type Result } from '@aegis/ink-io';
import { ENV } from './env';

/** The only door from UI to chain/venue. All IO goes through @aegis/ink-io. */
export const inkClient = makeInkClient(ENV.inkRpc);

export const nadoConfig: NadoConfig = {
  gatewayBase: ENV.nadoGateway,
  archiveBase: ENV.nadoArchive,
  mode: 'chain',
  maxSubaccounts: 8,
};

export function loadBook(address: `0x${string}`): Promise<BookRead> {
  return readBook(address, { client: inkClient, nado: nadoConfig });
}

export function loadHead(): Promise<Result<ChainHead>> {
  return readHead(inkClient);
}
