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
  const html = `<!doctype html><html><body style="margin:0;background:#F5F3EE;padding:32px 16px;font-family:'IBM Plex Mono',Menlo,monospace;color:#1A1E22">
<table role="presentation" width="100%" style="max-width:520px;margin:0 auto;border:1px solid #C6C0B2;background:#FBFAF7"><tr><td style="padding:28px">
<div style="font-weight:600;letter-spacing:6px;font-size:16px">${BRAND.name}</div>
<p style="font-size:14px;line-height:1.6;color:#1A1E22;margin:22px 0 18px">Sign in to ${esc(BRAND.display)}.</p>
<a href="${esc(link)}" style="display:inline-block;background:#1F5C4A;color:#FFFFFF;text-decoration:none;font-weight:600;letter-spacing:2px;font-size:12px;padding:12px 18px">SIGN IN</a>
<p style="font-size:12px;line-height:1.6;color:#5B6268;margin:20px 0 0">The link works once and expires in ${minutes} minutes. If you didn't ask to sign in, ignore this email.</p>
<p style="font-size:12px;line-height:1.6;color:#5B6268;margin:12px 0 0">${esc(BRAND.display)} never asks for your wallet, keys or seed phrase.</p>
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

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function simpleMail(to: string, subject: string, lines: string[], button?: { label: string; href: string }): Mail {
  const text = [...lines, ...(button ? ['', `${button.label}: ${button.href}`] : []), '', `${BRAND.display} is read-only and never asks for your wallet, keys or seed phrase. ${BRAND.siteUrl}`].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#F5F3EE;padding:32px 16px;font-family:'IBM Plex Mono',Menlo,monospace;color:#1A1E22">
<table role="presentation" width="100%" style="max-width:520px;margin:0 auto;border:1px solid #C6C0B2;background:#FBFAF7"><tr><td style="padding:28px">
<div style="font-weight:600;letter-spacing:6px;font-size:16px">${BRAND.name}</div>
${lines.map((l) => `<p style="font-size:14px;line-height:1.6;color:#1A1E22;margin:16px 0 0">${esc(l)}</p>`).join('')}
${button ? `<p style="margin:22px 0 0"><a href="${esc(button.href)}" style="display:inline-block;background:#1F5C4A;color:#FFFFFF;text-decoration:none;font-weight:600;letter-spacing:2px;font-size:12px;padding:12px 18px">${esc(button.label.toUpperCase())}</a></p>` : ''}
<p style="font-size:12px;line-height:1.6;color:#5B6268;margin:22px 0 0">${esc(BRAND.display)} is read-only and never asks for your wallet, keys or seed phrase.</p>
</td></tr></table></body></html>`;
  return { to, subject, text, html };
}

export function receiptMail(to: string, o: { planName: string; usd: number; paidUntil: string; site: string }): Mail {
  return simpleMail(
    to,
    `${BRAND.display} ${o.planName} — payment received`,
    [`Payment received: ${o.planName}, $${o.usd} for 30 days.`, `Your plan is paid to ${day(o.paidUntil)} (UTC).`, `We'll email you a renewal link a few days before it ends. Nothing renews by itself.`],
    { label: 'Open Phrourax', href: `${o.site}/account` },
  );
}

export function renewalMail(to: string, o: { planName: string; paidUntil: string; site: string; ended: boolean }): Mail {
  return simpleMail(
    to,
    o.ended ? `${BRAND.display} ${o.planName} has ended` : `${BRAND.display} ${o.planName} ends ${day(o.paidUntil)}`,
    o.ended
      ? [`Your ${o.planName} plan ended on ${day(o.paidUntil)} (UTC).`, `Your account is still here — renew any time to pick up where you left off.`]
      : [`Your ${o.planName} plan is paid to ${day(o.paidUntil)} (UTC).`, `To keep it, pay for the next 30 days — time is added to the end of your current period, so renewing early loses nothing.`],
    { label: o.ended ? 'Renew' : 'Renew now', href: `${o.site}/pricing` },
  );
}
