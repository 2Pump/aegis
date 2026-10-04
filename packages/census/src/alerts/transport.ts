/**
 * ALERTS — delivery adapters. The engine talks to an interface; Telegram is one adapter (./node/telegram.ts), the
 * test adapter below is another. Nothing in the engine knows which one it has.
 */
export interface IncomingMessage {
  updateId: number;
  chatId: string;
  text: string;
}

export type SendResult =
  | { ok: true }
  /** retryable: try again on a later run · blocked: the person blocked the bot / left — stop messaging that chat */
  | { ok: false; retryable: boolean; blocked: boolean; error: string };

export interface AlertsTransport {
  readonly name: string;
  /** messages since `offset` (exclusive cursor semantics are the adapter's), plus the next cursor */
  poll(offset: number): Promise<{ messages: IncomingMessage[]; next: number }>;
  send(chatId: string, text: string): Promise<SendResult>;
}

/** In-memory adapter for tests and dry runs: queue incoming text, inspect what was sent, script failures. */
export class TestTransport implements AlertsTransport {
  readonly name = 'test';
  inbox: IncomingMessage[] = [];
  sent: Array<{ chatId: string; text: string }> = [];
  /** chatId → result to return instead of success (e.g. blocked) */
  fail = new Map<string, SendResult>();
  private nextId = 1;

  say(chatId: string, text: string): void {
    this.inbox.push({ updateId: this.nextId++, chatId, text });
  }
  async poll(offset: number) {
    const messages = this.inbox.filter((m) => m.updateId >= offset);
    return { messages, next: messages.length ? Math.max(...messages.map((m) => m.updateId)) + 1 : offset };
  }
  async send(chatId: string, text: string): Promise<SendResult> {
    const f = this.fail.get(chatId);
    if (f) return f;
    this.sent.push({ chatId, text });
    return { ok: true };
  }
  to(chatId: string): string[] {
    return this.sent.filter((s) => s.chatId === chatId).map((s) => s.text);
  }
}
