// Immutable 03:12 ICT snapshot of one board: Top 10, the rest, media status and the revenue cohort.
import { TOP, boardPath, icon, productHref, rankBadge, sampleTag } from './components';
import { boardLabel, formatCount, formatIctDateTime, formatIctTime, formatMoney, formatRankUnits } from './format';
import { html, httpUrl, seg, type SafeHtml } from './html';
import { layout } from './layout';
import type { LayoutContext, SnapshotItemView, SnapshotView } from './types';

const REMOVED_NOTE = 'Removed from publication after the lock. The recorded rank is kept unchanged.';

function itemName(item: SnapshotItemView): SafeHtml {
  return item.visibilityState === 'removed_from_publication'
    ? html`<s>${item.name}</s>`
    : html`<a href="${productHref(item.slug)}">${item.name}</a>`;
}

function topCard(item: SnapshotItemView): SafeHtml {
  const removed = item.visibilityState === 'removed_from_publication';
  return html`<li class="snap-card${removed ? ' is-removed' : ''}">${rankBadge(item.rank)}<div class="snap-body"><h3>${itemName(item)}${sampleTag(item.isSample)}</h3>${
    removed ? html`<p class="removed-note">${REMOVED_NOTE}</p>` : ''
  }<p class="snap-meta"><span>${formatCount(item.ownerSuccessfulReferrals)} referrals</span><span>${formatCount(item.validClicks)} clicks</span><span>${formatCount(item.validViews)} views</span></p></div><p class="snap-amt">${
    item.rankUnits > 0 ? formatRankUnits(item.rankUnits) : 'Free'
  }</p></li>`;
}

function restRow(item: SnapshotItemView): SafeHtml {
  const removed = item.visibilityState === 'removed_from_publication';
  return html`<tr${removed ? html` class="is-removed"` : ''}><td class="num">${item.rank}</td><td>${itemName(item)}${sampleTag(item.isSample)}${
    removed ? html`<span class="removed-note">${REMOVED_NOTE}</span>` : ''
  }</td><td class="num">${item.rankUnits > 0 ? formatRankUnits(item.rankUnits) : 'Free'}</td><td class="num">${formatCount(
    item.ownerSuccessfulReferrals,
  )}</td><td class="num">${formatCount(item.validClicks)}</td><td class="num">${formatCount(item.validViews)}</td></tr>`;
}

function dateLink(board: string, date: string | null, label: string, rel: 'prev' | 'next'): SafeHtml {
  if (!date) return html`<span class="snap-nav-off">${label}</span>`;
  return html`<a class="btn btn-ghost btn-sm" rel="${rel}" href="/s/${board}/${seg(date)}">${label}: ${date}</a>`;
}

export function snapshotPage(ctx: LayoutContext, view: SnapshotView): string {
  const label = boardLabel(view.board);
  const top = view.items.filter((i) => i.rank <= TOP);
  const rest = view.items.filter((i) => i.rank > TOP);
  const lockTime = formatIctTime(view.cutoffAt) || '03:12';

  const media = view.media.length
    ? html`<ul class="media-list">${view.media.map((m) => {
        const text = `${m.kind}${m.platform ? ` · ${m.platform}` : ''}: ${m.status}`;
        const url = httpUrl(m.url);
        return html`<li><code>${text}</code>${url ? html` <a href="${url}" rel="nofollow noopener noreferrer">open</a>` : ''}</li>`;
      })}</ul>`
    : html`<p class="muted">No media recorded for this snapshot.</p>`;

  const cohort = view.cohort.length
    ? html`<div class="table-wrap"><table class="data-table"><caption class="sr-only">Revenue cohort for this snapshot</caption><thead><tr><th scope="col">Currency</th><th scope="col" class="num">Eligible revenue</th><th scope="col" class="num">Ads fund 80%</th><th scope="col" class="num">Referral commission</th><th scope="col" class="num">Operator</th></tr></thead><tbody>${view.cohort.map(
        (c) =>
          html`<tr><th scope="row">${c.currency}</th><td class="num">${formatMoney(c.currency, c.eligibleRevenueMinor)}</td><td class="num">${formatMoney(
            c.currency,
            c.adsFundMinor,
          )}</td><td class="num">${formatMoney(c.currency, c.commissionMinor)}</td><td class="num">${formatMoney(c.currency, c.operatorMinor)}</td></tr>`,
      )}</tbody></table></div>`
    : html`<p class="muted">No confirmed revenue in this cohort.</p>`;

  const body = html`<section class="section-tight snapshot" aria-labelledby="snap-title">
  <div class="wrap">
    <p class="kicker">Snapshot · permanent record</p>
    <h1 class="h2" id="snap-title">${label} · ${view.date} · locked ${lockTime} ICT</h1>
    <p class="section-lede">This board was frozen at ${formatIctDateTime(view.cutoffAt)}. It never changes, even when new bids, referrals or clicks arrive. The Top 10 goes into that night's video.</p>
    <p class="snap-facts"><span>Executed ${formatIctDateTime(view.executedAt)}</span><span>Ranking policy ${view.rankingPolicyVersion}</span><a href="${boardPath(view.board)}">Live ${label} board ${icon('arrow')}</a></p>
    <nav class="snap-nav" aria-label="Other snapshots">${dateLink(view.board, view.prevDate, 'Previous', 'prev')}${dateLink(
      view.board,
      view.nextDate,
      'Next',
      'next',
    )}</nav>

    <h2 class="snap-h">Top 10</h2>
    ${top.length ? html`<ol class="snap-top">${top.map(topCard)}</ol>` : html`<p class="muted">No products were on the board at the lock.</p>`}

    ${rest.length
      ? html`<h2 class="snap-h">Below the cutoff</h2><div class="table-wrap"><table class="data-table"><thead><tr><th scope="col" class="num">Rank</th><th scope="col">Product</th><th scope="col" class="num">Bid</th><th scope="col" class="num">Referrals</th><th scope="col" class="num">Clicks</th><th scope="col" class="num">Views</th></tr></thead><tbody>${rest.map(
          restRow,
        )}</tbody></table></div>`
      : ''}

    <div class="snap-grid">
      <section class="panel-box snap-panel" aria-labelledby="media-title"><h2 id="media-title">Media</h2><p class="muted">Status is shown exactly as recorded by each adapter.</p>${media}</section>
      <section class="panel-box snap-panel" aria-labelledby="cohort-title"><h2 id="cohort-title">Revenue cohort</h2><p class="muted">80% of eligible revenue funds ads for the ${label} board.</p>${cohort}</section>
    </div>
  </div>
</section>`;
  return layout(ctx, body.toString());
}
