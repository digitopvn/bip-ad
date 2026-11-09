// Shared building blocks for every email: a small document model, HTML escaping, URL
// validation, and the renderer that turns one document into table-based HTML plus plain text.
// Pure functions only. All dynamic values pass through esc() / safeHref() before reaching HTML.
import type { EmailRenderContext, RenderedEmail } from '../email-message-types';

/** A text cell that may carry a link; the link is dropped unless it is http(s). */
export type Cell = string | { text: string; url: string };

export type Block =
  | { t: 'p'; text: string }
  | { t: 'facts'; rows: [label: string, value: Cell][] }
  | { t: 'table'; head: string[]; rows: Cell[][] }
  | { t: 'note'; text: string }
  | { t: 'code'; text: string };

export interface EmailDoc {
  /** Subject without the environment prefix. */
  subject: string;
  /** Hidden inbox preview text. */
  preheader: string;
  heading: string;
  blocks: Block[];
  cta?: { label: string; url: string };
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value: string): string {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** Returns the URL only when it is an absolute http(s) URL; otherwise null so callers omit the link. */
export function safeHref(url: string): string | null {
  const trimmed = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(trimmed) || /[\s\u0000-\u001f]/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Subjects and text parts must stay on one line, whatever a user typed into a name. */
export function oneLine(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
}

const C = { bg: '#f8f7fc', card: '#ffffff', ink: '#1b1633', muted: '#6b6684', line: '#e6e3f1', brand: '#4a2bd8', accent: '#8a12fc', noteBg: '#f1edff' };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function cellHtml(c: Cell): string {
  if (typeof c === 'string') return esc(c);
  const href = safeHref(c.url);
  return href ? `<a href="${esc(href)}" style="color:${C.brand};text-decoration:underline">${esc(c.text)}</a>` : esc(c.text);
}

function cellPlain(c: Cell): string {
  if (typeof c === 'string') return c;
  const href = safeHref(c.url);
  return href ? `${c.text} (${href})` : c.text;
}

function blockHtml(b: Block): string {
  const p = `margin:0 0 16px;font:15px/1.55 ${FONT};color:${C.ink}`;
  switch (b.t) {
    case 'p':
      return `<p style="${p}">${esc(b.text)}</p>`;
    case 'note':
      return `<div style="margin:0 0 16px;padding:12px 14px;background:${C.noteBg};border-left:4px solid ${C.accent};border-radius:6px;font:14px/1.5 ${FONT};color:${C.ink}">${esc(b.text)}</div>`;
    case 'code':
      return `<p style="margin:0 0 16px;padding:10px 12px;background:${C.noteBg};border-radius:6px;font:14px/1.4 Menlo,Consolas,monospace;color:${C.ink};word-break:break-all">${esc(b.text)}</p>`;
    case 'facts':
      return (
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-top:1px solid ${C.line}">` +
        b.rows
          .map(
            ([k, v]) =>
              `<tr><td style="padding:8px 12px 8px 0;border-bottom:1px solid ${C.line};font:13px/1.4 ${FONT};color:${C.muted};width:38%;vertical-align:top">${esc(k)}</td>` +
              `<td style="padding:8px 0;border-bottom:1px solid ${C.line};font:14px/1.4 ${FONT};color:${C.ink};vertical-align:top;word-break:break-word">${cellHtml(v)}</td></tr>`,
          )
          .join('') +
        '</table>'
      );
    case 'table': {
      const th = (h: string) => `<th align="left" style="padding:8px 6px;border-bottom:2px solid ${C.line};font:12px/1.3 ${FONT};color:${C.muted};text-transform:uppercase">${esc(h)}</th>`;
      const td = (c: Cell) => `<td style="padding:8px 6px;border-bottom:1px solid ${C.line};font:14px/1.4 ${FONT};color:${C.ink};vertical-align:top">${cellHtml(c)}</td>`;
      return (
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr>${b.head.map(th).join('')}</tr>` +
        b.rows.map((r) => `<tr>${r.map(td).join('')}</tr>`).join('') +
        '</table>'
      );
    }
  }
}

function blockText(b: Block): string {
  if (b.t === 'p' || b.t === 'note' || b.t === 'code') return b.text;
  if (b.t === 'facts') return b.rows.map(([k, v]) => `${k}: ${cellPlain(v)}`).join('\n');
  return [b.head.join(' | '), ...b.rows.map((r) => r.map(cellPlain).join(' | '))].join('\n');
}

function footerParts(ctx: EmailRenderContext) {
  const prefs = safeHref(ctx.preferencesUrl);
  const unsub = ctx.unsubscribeUrl === null ? null : safeHref(ctx.unsubscribeUrl);
  const lead =
    ctx.unsubscribeUrl === null
      ? 'This is a transactional notice about your bip.ad account, so it is sent regardless of your email preferences.'
      : 'You are receiving this because of your notification settings on bip.ad.';
  return { prefs, unsub, grouped: ctx.unsubscribeUrl !== null, lead };
}

/** Renders a document into the final subject, HTML and plain text. */
export function renderDoc(doc: EmailDoc, ctx: EmailRenderContext): RenderedEmail {
  const { prefs, unsub, grouped, lead } = footerParts(ctx);
  const cta = doc.cta ? { label: doc.cta.label, href: safeHref(doc.cta.url) } : null;
  const link = (href: string, label: string) => `<a href="${esc(href)}" style="color:${C.muted};text-decoration:underline">${esc(label)}</a>`;
  const footLinks = [unsub && link(unsub, 'Unsubscribe from these emails'), prefs && link(prefs, 'Manage email preferences')].filter(Boolean).join(' &middot; ');
  const button =
    cta && cta.href
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="background:${C.brand};border-radius:8px"><a href="${esc(cta.href)}" style="display:inline-block;padding:12px 22px;font:600 15px/1 ${FONT};color:#ffffff;text-decoration:none">${esc(cta.label)}</a></td></tr></table>`
      : '';

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(doc.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:${C.bg}"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(doc.preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${C.card};border:1px solid ${C.line};border-radius:12px"><tr><td style="padding:28px 28px 8px">` +
    `<div style="font:800 22px/1 ${FONT};color:${C.brand};margin:0 0 22px">bip.ad</div>` +
    `<h1 style="margin:0 0 16px;font:700 21px/1.3 ${FONT};color:${C.ink}">${esc(doc.heading)}</h1>` +
    doc.blocks.map(blockHtml).join('') +
    button +
    `</td></tr><tr><td style="padding:16px 28px 24px;border-top:1px solid ${C.line};font:12px/1.6 ${FONT};color:${C.muted}">` +
    `<div style="margin:0 0 6px">${esc(lead)}</div>${footLinks ? `<div>${footLinks}</div>` : ''}` +
    `</td></tr></table></td></tr></table></body></html>`;

  const textParts = [doc.heading, ...doc.blocks.map(blockText)];
  if (cta && cta.href) textParts.push(`${cta.label}: ${cta.href}`);
  const foot = [lead];
  if (grouped && unsub) foot.push(`Unsubscribe from these emails: ${unsub}`);
  if (prefs) foot.push(`Manage email preferences: ${prefs}`);
  textParts.push(`--\nbip.ad\n${foot.join('\n')}`);

  return { subject: `${ctx.subjectPrefix}${oneLine(doc.subject)}`, html, text: textParts.join('\n\n') + '\n' };
}

