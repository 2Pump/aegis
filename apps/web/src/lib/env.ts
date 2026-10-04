import { INK_DEFAULT_RPC, NADO_DIRECT } from '@aegis/ink-io';

const read = (k: string): string | undefined => {
  const v = (import.meta.env as Record<string, string | undefined>)[k];
  return v && v.trim() ? v.trim() : undefined;
};

export const ENV = {
  inkRpc: read('VITE_INK_RPC') ?? INK_DEFAULT_RPC,
  /**
   * Nado is read DIRECTLY from the viewer's browser — the same way app.nado.xyz does.
   * Nado's Cloudflare challenges every non-browser client (curl, dev proxy, servers), verified 2026-09-28,
   * so a server-side proxy cannot work and must not try to disguise itself as a browser.
   * Set VITE_NADO_GATEWAY=/nado/gateway to force the old proxy path (dev only).
   */
  nadoGateway: read('VITE_NADO_GATEWAY') ?? NADO_DIRECT.gateway,
  nadoArchive: read('VITE_NADO_ARCHIVE') ?? NADO_DIRECT.archive,
  /**
   * Telegram bot username for alerts. Set ONLY once the alerts workflow is switched on and a real end-to-end message
   * has been received; until then the Alerts page says "not live" and offers no way to sign up.
   */
  alertsBot: (() => {
    const b = read('VITE_ALERTS_BOT')?.replace(/^@/, '');
    return b && /^[A-Za-z0-9_]{5,32}$/.test(b) && /bot$/i.test(b) ? b : undefined;
  })(),
  /** Poll cadence (dossier §7) */
  hullPollMs: 15_000,
  maxBackoffMs: 5 * 60_000,
} as const;
