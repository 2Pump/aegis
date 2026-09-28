import type { InkErrorCode } from '@aegis/pose';

export type { InkErrorCode };

export interface InkError {
  code: InkErrorCode;
  message: string;
  /** seconds the venue asked us to wait, if it said so */
  retryAfterS?: number;
}

export type Result<T, E = InkError> = { ok: true; value: T } | { ok: false; error: E };

export const Ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const Err = (code: InkErrorCode, message: string, retryAfterS?: number): Result<never> => ({
  ok: false,
  error: retryAfterS === undefined ? { code, message } : { code, message, retryAfterS },
});

export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message.split('\n')[0] ?? e.message;
  return String(e);
}
