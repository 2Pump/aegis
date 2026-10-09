/**
 * Sign-in email. Sent through Resend's HTTP API (RESEND_API_KEY) from MAIL_FROM, default signin@phrourax.com —
 * the domain must be verified in Resend first (docs/ACCOUNTS.md).
 */
import { BRAND } from '@aegis/glyphs';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}
export type Mailer = (m: Mail) => Promise<void>;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function signInMail(to: string, link: string, minutes: number): Mail {
  const text = [
    `Sign in to ${BRAND.display}:`,
    '',
    link,
    '',
    `The link works once and expires in ${minutes} minutes.`,
    `If you didn't ask to sign in, ignore this email — nothing happens without the link.`,
    '',
    `${BRAND.display} never asks for your wallet, keys or seed phrase. ${BRAND.siteUrl}`,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#05080c;padding:32px 16px;font-family:'IBM Plex Mono',Menlo,monospace;color:#cfd9e3">
<table role="presentation" width="100%" style="max-width:520px;margin:0 auto;border:1px solid #1d2b33;background:#04060a"><tr><td style="padding:28px">
<div style="font-weight:600;letter-spacing:6px;font-size:16px">${BRAND.name}</div>
<p style="font-size:14px;line-height:1.6;color:#cfd9e3;margin:22px 0 18px">Sign in to ${esc(BRAND.display)}.</p>
<a href="${esc(link)}" style="display:inline-block;background:#4ce0d2;color:#020305;text-decoration:none;font-weight:600;letter-spacing:2px;font-size:12px;padding:12px 18px">SIGN IN</a>
<p style="font-size:12px;line-height:1.6;color:#7d8b9b;margin:20px 0 0">The link works once and expires in ${minutes} minutes. If you didn't ask to sign in, ignore this email.</p>
<p style="font-size:12px;line-height:1.6;color:#7d8b9b;margin:12px 0 0">${esc(BRAND.display)} never asks for your wallet, keys or seed phrase.</p>
</td></tr></table></body></html>`;
  return { to, subject: `Sign in to ${BRAND.display}`, text, html };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export function resendMailer(o: { apiKey: string; from: string; fetch?: FetchLike }): Mailer {
  const f = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  return async (m) => {
    const r = await f('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: o.from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
    });
    if (!r.ok) throw new Error(`email not sent: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
  };
}
