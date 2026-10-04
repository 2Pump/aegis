/**
 * What a live alerts run needs, checked BEFORE anything runs. Missing or malformed → the run refuses with a list of
 * what's wrong (and never prints a secret's value). There are no defaults and no placeholder secrets.
 */
import { TELEGRAM_TOKEN_RE } from './telegram.js';

export interface AlertsEnvCheck {
  ok: boolean;
  problems: string[];
}

export function checkAlertsEnv(env: Record<string, string | undefined>, opts: { store: 'blob' | 'file' }): AlertsEnvCheck {
  const problems: string[] = [];
  const tok = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!tok) problems.push('TELEGRAM_BOT_TOKEN is not set (create the bot with @BotFather)');
  else if (!TELEGRAM_TOKEN_RE.test(tok)) problems.push('TELEGRAM_BOT_TOKEN does not look like a bot token ("<digits>:<secret>")');
  const key = env.ALERTS_STORE_KEY?.trim();
  if (!key) problems.push('ALERTS_STORE_KEY is not set (32 random bytes, base64)');
  else if (Buffer.from(key, 'base64').length !== 32) problems.push('ALERTS_STORE_KEY must decode to exactly 32 bytes');
  if (opts.store === 'blob' && !env.BLOB_READ_WRITE_TOKEN?.trim()) problems.push('BLOB_READ_WRITE_TOKEN is not set (needed for --store blob)');
  const site = env.ALERTS_SITE_URL?.trim();
  if (site && !/^https:\/\/[^\s/]+/.test(site)) problems.push('ALERTS_SITE_URL must be an https:// URL');
  return { ok: problems.length === 0, problems };
}
