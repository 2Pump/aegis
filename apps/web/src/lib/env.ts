import { INK_PUBLIC_RPCS, NADO_DIRECT } from '@aegis/ink-io';

const read = (k: string): string | undefined => {
  const v = (import.meta.env as Record<string, string | undefined>)[k];
  return v && v.trim() ? v.trim() : undefined;
};

export const ENV = {
  /**
   * Every visitor's browser reads Ink directly. By default the reads are spread round-robin over Ink's four public
   * RPCs (one that throttles or fails rests 20 s), so many visitors don't all lean on one provider.
   * VITE_INK_RPC (one URL or a comma-separated list) overrides it, e.g. with a paid endpoint.
   */
  inkRpc: read('VITE_INK_RPC') ?? INK_PUBLIC_RPCS.join(','),
  /**
   * Nado is read DIRECTLY from the viewer's browser — the same way app.nado.xyz does.
   * Nado's Cloudflare challenges every non-browser client (curl, dev proxy, servers), verified 2026-09-28,
   * so a server-side proxy cannot work and must not try to disguise itself as a browser.
   * Set VITE_NADO_GATEWAY=/nado/gateway to force the old proxy path (dev only).
   */
  nadoGateway: read('VITE_NADO_GATEWAY') ?? NADO_DIRECT.gateway,
  nadoArchive: read('VITE_NADO_ARCHIVE') ?? NADO_DIRECT.archive,
  /** Poll cadence (dossier §7) */
  hullPollMs: 15_000,
  maxBackoffMs: 5 * 60_000,
} as const;
