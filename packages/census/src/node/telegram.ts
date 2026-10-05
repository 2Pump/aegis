/**
 * Telegram adapter for Phrourax alerts (Bot API over HTTPS, long-poll-free: one getUpdates per run).
 * The bot token is read from the environment on the server only; it is never logged, never written to the store,
 * never sent to the browser. Only PRIVATE chats are served — in a group, other members would see someone's wallets.
 */
import type { AlertsTransport, IncomingMessage, SendResult } from '../alerts/transport.js';

export const TELEGRAM_TOKEN_RE = /^\d{5,12}:[A-Za-z0-9_-]{30,}$/;

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}
interface TgUpdate {
  update_id: number;
  message?: { chat?: { id?: number | string; type?: string }; text?: string };
}

export interface TelegramOpts {
  token: string;
  fetch?: FetchLike;
  /** longest wait honoured for a 429 retry_after inside one send (longer → retried next run) */
  maxRetryAfterS?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function telegramTransport(opts: TelegramOpts): AlertsTransport {
  if (!TELEGRAM_TOKEN_RE.test(opts.token)) throw new Error('TELEGRAM_BOT_TOKEN is not a valid bot token (expected "<digits>:<secret>" from @BotFather)');
  const f: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i as RequestInit) as unknown as ReturnType<FetchLike>);
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const base = `https://api.telegram.org/bot${opts.token}`;
  // never let the token leak into an error message or a log line
  const scrub = (s: string) => s.split(opts.token).join('<token>');

  const call = async <T>(method: string, body: unknown): Promise<{ status: number; r: TgResponse<T> }> => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20_000);
    try {
      const res = await f(`${base}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      return { status: res.status, r: (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as TgResponse<T> };
    } finally {
      clearTimeout(t);
    }
  };

  return {
    name: 'telegram',
    async poll(offset) {
      let out: { status: number; r: TgResponse<TgUpdate[]> };
      try {
        out = await call<TgUpdate[]>('getUpdates', { offset, timeout: 0, allowed_updates: ['message'] });
      } catch (e) {
        throw new Error(scrub(`Telegram getUpdates: ${String(e)}`));
      }
      if (!out.r.ok || !Array.isArray(out.r.result)) throw new Error(scrub(`Telegram getUpdates: ${out.r.description ?? `HTTP ${out.status}`}`));
      const ups = out.r.result;
      const messages: IncomingMessage[] = [];
      for (const u of ups) {
        const chat = u.message?.chat;
        if (!chat || chat.id === undefined || typeof u.message?.text !== 'string') continue;
        if (chat.type !== 'private') continue; // groups/channels are ignored, never answered
        messages.push({ updateId: u.update_id, chatId: String(chat.id), text: u.message.text.slice(0, 500) });
      }
      return { messages, next: ups.length ? Math.max(...ups.map((u) => u.update_id)) + 1 : offset };
    },
    async send(chatId, text): Promise<SendResult> {
      for (let attempt = 0; attempt < 2; attempt++) {
        let out: { status: number; r: TgResponse<unknown> };
        try {
          out = await call('sendMessage', { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true });
        } catch (e) {
          return { ok: false, retryable: true, blocked: false, error: scrub(`network: ${String(e)}`) };
        }
        if (out.r.ok) return { ok: true };
        const code = out.r.error_code ?? out.status;
        const desc = scrub(out.r.description ?? `HTTP ${out.status}`);
        if (code === 429) {
          const wait = out.r.parameters?.retry_after ?? 5;
          if (attempt === 0 && wait <= (opts.maxRetryAfterS ?? 30)) {
            await sleep(wait * 1000);
            continue;
          }
          return { ok: false, retryable: true, blocked: false, error: `rate limited by Telegram (${desc})` };
        }
        if (code === 403 || (code === 400 && /chat not found|user is deactivated|chat_id is empty/i.test(desc))) return { ok: false, retryable: false, blocked: true, error: desc };
        return { ok: false, retryable: code >= 500, blocked: false, error: desc };
      }
      return { ok: false, retryable: true, blocked: false, error: 'rate limited by Telegram' };
    },
  };
}
