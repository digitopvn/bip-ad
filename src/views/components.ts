// Shared building blocks in the "Open Studio" card language: icons, segment-digit rank badges,
// product cards and board lists. Everything returns SafeHtml; user strings are escaped by `html`.
import { html, imageUrl, raw, seg, type SafeHtml } from './html';
import { boardLabel, formatCount, formatRankUnits } from './format';
import type { BoardCode, BoardRow, BoardView } from './types';

export const TOP = 10;

export const ICON_SPRITE = raw(
  '<svg width="0" height="0" style="position:absolute" aria-hidden="true">' +
    '<symbol id="i-check" viewBox="0 0 20 20"><path d="M4.5 10.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></symbol>' +
    '<symbol id="i-cross" viewBox="0 0 20 20"><path d="M6 6l8 8M14 6l-8 8" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></symbol>' +
    '<symbol id="i-arrow" viewBox="0 0 20 20"><path d="M4 10h12M11 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></symbol>' +
    '<symbol id="i-down" viewBox="0 0 20 20"><path d="M10 4v12M5 11l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></symbol>' +
    '<symbol id="i-swap" viewBox="0 0 20 20"><path d="M4 7h11l-3-3M16 13H5l3 3" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></symbol>' +
    '<symbol id="i-plus" viewBox="0 0 20 20"><path d="M10 4v12M4 10h12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></symbol>' +
    '<symbol id="i-menu" viewBox="0 0 20 20"><path d="M3 6h14M3 10h14M3 14h14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></symbol>' +
    '<symbol id="i-lock" viewBox="0 0 20 20"><path d="M6 9V7a4 4 0 0 1 8 0v2M5 9h10v8H5z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></symbol>' +
    '<symbol id="i-out" viewBox="0 0 20 20"><path d="M8 4H4v12h12v-4M11 4h5v5M16 4l-7 7" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></symbol>' +
    '</svg>',
);

export type IconName = 'check' | 'cross' | 'arrow' | 'down' | 'swap' | 'plus' | 'menu' | 'lock' | 'out';

export function icon(name: IconName): SafeHtml {
  return raw(`<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`);
}

// ---------------------------------------------------------------- segment digits
// Same geometry the client uses (public/app.js segDigits) so live rank updates match.
const SEG_S = 8;
const SEG_T = 2.6;
const SEG_GAP = 1.4;
const SEG_SPACING = 3.4;
const SEG_GEOMETRY: [string, number, number, boolean][] = [
  ['a', SEG_S / 2, 0, false],
  ['b', SEG_S, SEG_S / 2, true],
  ['c', SEG_S, (3 * SEG_S) / 2, true],
  ['d', SEG_S / 2, 2 * SEG_S, false],
  ['e', 0, (3 * SEG_S) / 2, true],
  ['f', 0, SEG_S / 2, true],
  ['g', SEG_S / 2, SEG_S, false],
];

const num = (n: number): string => String(Math.round(n * 1000) / 1000);

/** Segment-display digits for rank badges. Text is limited to 0-9 by construction. */
export function segDigits(value: number): SafeHtml {
  const text = String(Math.max(0, Math.trunc(value))).padStart(2, '0');
  const L = SEG_S - SEG_GAP;
  let cells = '';
  let x = 0;
  for (const ch of text) {
    let rects = '';
    for (const [name, cx, cy, vert] of SEG_GEOMETRY) {
      rects +=
        `<rect class="s-${name}" x="${num(-L / 2)}" y="${num(-SEG_T / 2)}" width="${num(L)}" height="${num(SEG_T)}" ` +
        `rx="${num(SEG_T / 2)}" transform="translate(${num(cx)} ${num(cy)})${vert ? ' rotate(90)' : ''}"/>`;
    }
    cells += `<g class="sd" data-d="${ch}" transform="translate(${num(x)} 0)">${rects}</g>`;
    x += SEG_S + SEG_SPACING;
  }
  const width = text.length * SEG_S + (text.length - 1) * SEG_SPACING + SEG_T;
  const height = 2 * SEG_S + SEG_T;
  return raw(
    `<svg class="rank-seg" viewBox="${num(-SEG_T / 2)} ${num(-SEG_T / 2)} ${num(width)} ${num(height)}" ` +
      `width="${num(width)}" height="${num(height)}" aria-hidden="true" focusable="false">${cells}</svg>`,
  );
}

export function rankBadge(rank: number): SafeHtml {
  return html`<span class="rank"><span class="rank-no" aria-hidden="true">No.</span>${segDigits(rank)}<span class="sr-only" data-rank-text>Rank ${rank}</span></span>`;
}

export function sampleTag(isSample: boolean): SafeHtml | '' {
  return isSample ? html` <span class="sample">sample</span>` : '';
}

// ---------------------------------------------------------------- product cards
/** Stable cover hue in the brand's cyan→violet range, derived from the slug. */
export function hueFor(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return 205 + (h % 110);
}

function initial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : '?';
}

export type Tier = 'lead' | 'podium' | 'top' | 'standby' | 'free';

export function tierOf(rank: number, paid: boolean, inMainList: boolean): Tier {
  if (!inMainList) return 'free';
  if (rank === 1) return 'lead';
  if (rank <= 3) return 'podium';
  if (rank <= TOP) return 'top';
  return paid ? 'standby' : 'free';
}

export function productHref(slug: string): string {
  return `/p/${seg(slug)}`;
}

function cover(name: string, img: string | null | undefined): SafeHtml {
  const src = imageUrl(img ?? null);
  return html`<span class="cover" aria-hidden="true"><span>${initial(name)}</span>${
    src ? html`<img src="${src}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''
  }</span>`;
}

function card(row: BoardRow, tier: Tier, tie: boolean): SafeHtml {
  const paid = row.activeRankUnits > 0;
  return html`<li class="item" data-product-id="${row.productId}" data-bid="${row.activeRankUnits}" data-rank="${row.rank}" data-tier="${tier}"${
    tie ? raw(' data-tie') : ''
  } style="--h:${hueFor(row.slug)}">
${rankBadge(row.rank)}${cover(row.name, row.imageUrl)}<span class="item-body"><h3 class="item-name"><a href="${productHref(row.slug)}" data-product>${row.name}</a>${sampleTag(row.isSample)}</h3><span class="item-tag">${row.tagline}</span><span class="item-meta"><span>${formatCount(row.ownerSuccessfulReferrals)} referrals</span><span>${formatCount(row.validClicks)} valid clicks</span></span></span><span class="item-bid"><span class="bid-label" data-bid-label>${paid ? 'Active bid' : 'Listing'}</span><span class="bid-amt" data-amt>${paid ? formatRankUnits(row.activeRankUnits) : 'Free'}</span></span></li>`;
}

function cutoffCard(seatsLeft: number): SafeHtml {
  const text =
    seatsLeft > 0
      ? `${seatsLeft === 1 ? 'One seat is' : `${seatsLeft} seats are`} still open in tonight's Top 10.`
      : "The ten before this card go into tonight's video.";
  return html`<li class="cutoff" data-cutoff><span class="cut-k">Top 10 cutoff</span><p>${text}</p><a class="cut-link" href="/#agents">Put your product here</a></li>`;
}

/**
 * The gallery for one board: Top 10 (lead, podium, top) with the cutoff card after #10,
 * paid standby rows, then free listings. Free rows fill the Top 10 when fewer than ten are paid.
 */
export function boardLists(view: BoardView): SafeHtml {
  const rows = view.rows;
  if (rows.length === 0) {
    return html`<div class="empty" data-empty><p class="empty-title">No products on the ${boardLabel(view.board)} board yet.</p><p>Connect your AI agent over MCP, list your product and it appears here once moderation approves it.</p><a class="btn btn-primary btn-sm" href="/#agents">Be the first: list via MCP ${icon('arrow')}</a></div>`;
  }
  const main = rows.filter((r) => r.rank <= TOP || r.activeRankUnits > 0);
  const free = rows.filter((r) => !(r.rank <= TOP || r.activeRankUnits > 0));
  const tieAt = (i: number): boolean => {
    const r = main[i];
    if (!r || r.activeRankUnits <= 0) return false;
    return main[i - 1]?.activeRankUnits === r.activeRankUnits || main[i + 1]?.activeRankUnits === r.activeRankUnits;
  };
  const items: SafeHtml[] = [];
  main.forEach((r, i) => {
    items.push(card(r, tierOf(r.rank, r.activeRankUnits > 0, true), tieAt(i)));
    if (r.rank === TOP) items.push(cutoffCard(0));
  });
  if (!main.some((r) => r.rank === TOP)) items.push(cutoffCard(Math.max(0, TOP - main.length)));
  const title = boardLabel(view.board);
  const freeStart = free[0]?.rank ?? main.length + 1;
  return html`<ol class="list list-main" aria-label="${title} board, ranked listings">${items}</ol>
<div class="free-sec" data-free-sec${free.length ? '' : raw(' hidden')}><h3 class="free-head">Free listings <span>Always below paid, ordered by referrals, then valid clicks, then valid views.</span></h3>
<ol class="list list-free" start="${freeStart}" aria-label="${title} board, free listings">${free.map((r) => card(r, 'free', false))}</ol></div>`;
}

/** Countdown element; app.js ticks it toward the ISO target and rolls over each day. */
export function countdown(targetIso: string, initialText: string): SafeHtml {
  return html`<time class="countdown" data-countdown="${targetIso}" datetime="${targetIso}" role="timer">${initialText}</time>`;
}

export function boardPath(board: BoardCode): string {
  return `/${board}`;
}

/** Status/notice box shared by checkout, product and account pages. */
export function notice(kind: 'info' | 'ok' | 'warn' | 'error', body: SafeHtml | string, role: 'status' | 'alert' | null = 'status'): SafeHtml {
  return html`<div class="notice notice-${kind}"${role ? raw(` role="${role}"`) : ''}>${body}</div>`;
}

export function copyField(id: string, value: string, label: string): SafeHtml {
  return html`<div class="endpoint"><code id="${id}">${value}</code><button class="btn btn-ghost btn-sm" type="button" data-copy="#${id}" aria-label="${label}">Copy</button><span class="sr-only" aria-live="polite" data-copy-status></span></div>`;
}

/** Link to the most recent immutable snapshot of a board. */
export function lastLockLink(board: BoardCode, date: string | undefined): SafeHtml | '' {
  if (!date) return '';
  return html`<a class="last-lock" href="/s/${board}/${seg(date)}">${icon('lock')}<span>Last lock: ${boardLabel(board)} · ${date}</span></a>`;
}
