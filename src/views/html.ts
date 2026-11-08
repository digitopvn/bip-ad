// Minimal HTML templating with escape-by-default interpolation.
// Every interpolated value is escaped unless it is a SafeHtml produced by `html` or `raw`.

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"'`]/g, (ch) => ESCAPES[ch] ?? ch);
}

/** Markup that is already safe to emit verbatim. Construct only via `html` or `raw`. */
export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

/** Marks trusted, developer-authored markup as safe. Never pass user content to this. */
export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

export type HtmlValue = SafeHtml | string | number | boolean | null | undefined | readonly HtmlValue[];

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map((v: HtmlValue) => render(v)).join('');
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return escapeHtml(value);
}

/** Tagged template: `html\`<p>${userText}</p>\`` escapes userText; nested `html` stays intact. */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + (strings[i + 1] ?? '');
  }
  return new SafeHtml(out);
}

/** Joins fragments without escaping SafeHtml items (strings are escaped). */
export function join(items: readonly HtmlValue[], separator = ''): SafeHtml {
  return new SafeHtml(items.map((v) => render(v)).join(separator));
}

/** Returns the URL when it is an absolute http(s) URL, otherwise null. */
export function httpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Accepts absolute http(s) URLs or root-relative paths (not protocol-relative). */
export function imageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\/(?![/\\])/.test(trimmed)) return trimmed;
  return httpUrl(trimmed);
}

/** Encodes a single path segment such as a slug or date. */
export function seg(value: string): string {
  return encodeURIComponent(value);
}
