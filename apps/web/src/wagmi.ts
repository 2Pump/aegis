import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { ink } from '@aegis/ink-io';
import { ENV } from './lib/env';

/**
 * Connect is OPTIONAL and exists only to "focus my ship" (read the connected address).
 * Injected wallets only — no WalletConnect project id, no signing, no transactions anywhere in the app.
 */
export const wagmiConfig = createConfig({
  chains: [ink],
  connectors: [injected()],
  transports: { [ink.id]: http(ENV.inkRpc) },
});
