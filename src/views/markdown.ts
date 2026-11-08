// Minimal, safe markdown subset for the rich_text widget. Raw HTML is never passed through:
// every text run is escaped, and links are emitted only for absolute http(s) URLs.
// Supported: paragraphs, ## / ### headings, - / * / 1. lists, **bold**, *italic*, `code`, [text](https://…).
import { html, httpUrl, join, type SafeHtml } from './html';

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

function inline(text: string, depth = 0): SafeHtml {
  const parts: (SafeHtml | string)[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const index = m.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    const [whole, code, bold, italic, linkText, linkUrl] = m;
    const nested = (s: string): SafeHtml | string => (depth < 3 ? inline(s, depth + 1) : s);
    if (code !== undefined) parts.push(html`<code>${code}</code>`);
    else if (bold !== undefined) parts.push(html`<strong>${nested(bold)}</strong>`);
    else if (italic !== undefined) parts.push(html`<em>${nested(italic)}</em>`);
    else if (linkText !== undefined) {
      const url = httpUrl(linkUrl);
      parts.push(url ? html`<a href="${url}" rel="nofollow ugc noopener noreferrer">${nested(linkText)}</a>` : whole);
    }
    last = index + whole.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return join(parts);
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h2' | 'h3'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] };

export function renderMarkdown(markdown: string): SafeHtml {
  const blocks: Block[] = [];
  let current: Block | null = null;
  const flush = (): void => {
    if (current) blocks.push(current);
    current = null;
  };
  for (const rawLine of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (trimmed === '') {
      flush();
      continue;
    }
    const heading = /^(#{2,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flush();
      blocks.push({ kind: heading[1] === '##' ? 'h2' : 'h3', text: heading[2] ?? '' });
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    const ordered = /^\d{1,3}[.)]\s+(.+)$/.exec(trimmed);
    const listKind = bullet ? 'ul' : ordered ? 'ol' : null;
    const itemText = (bullet ?? ordered)?.[1];
    if (listKind && itemText !== undefined) {
      const cur = current as Block | null;
      if (cur && cur.kind === listKind) {
        cur.items.push(itemText);
      } else {
        flush();
        current = { kind: listKind, items: [itemText] };
      }
      continue;
    }
    const cur = current as Block | null;
    if (cur && cur.kind === 'p') {
      cur.lines.push(trimmed);
    } else {
      flush();
      current = { kind: 'p', lines: [trimmed] };
    }
  }
  flush();
  return join(
    blocks.map((b) => {
      switch (b.kind) {
        case 'h2':
          return html`<h2>${inline(b.text)}</h2>`;
        case 'h3':
          return html`<h3>${inline(b.text)}</h3>`;
        case 'ul':
          return html`<ul>${b.items.map((i) => html`<li>${inline(i)}</li>`)}</ul>`;
        case 'ol':
          return html`<ol>${b.items.map((i) => html`<li>${inline(i)}</li>`)}</ol>`;
        case 'p':
          return html`<p>${inline(b.lines.join(' '))}</p>`;
      }
    }),
    '\n',
  );
}
