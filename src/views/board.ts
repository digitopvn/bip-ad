// Dedicated live leaderboard for one board, in the same card language as the homepage gallery.
import { boardLists, boardPath, countdown, icon, lastLockLink } from './components';
import { BOARDS, boardLabel, boardWindow, formatCountdown } from './format';
import { html, raw } from './html';
import { layout } from './layout';
import type { BoardView, LayoutContext } from './types';

export function boardPage(ctx: LayoutContext, view: BoardView, lastSnapshotDate?: string): string {
  const label = boardLabel(view.board);
  const anySample = view.rows.some((r) => r.isSample);
  const body = html`<section class="board-sec board-page" aria-labelledby="board-title">
  <div class="wrap">
    <div class="board-head">
      <div>
        <p class="kicker">Live leaderboard</p>
        <h1 class="h2" id="board-title">${label} board</h1>
        <p class="board-sub">Ranked by active bid. Paid placement, never a rating of quality.${
          anySample ? html` <span class="sample">Includes sample listings</span>` : ''
        }</p>
      </div>
      <div class="board-ctrl">
        <nav class="tabs" aria-label="Boards">${BOARDS.map(
          (b) => html`<a class="tab" href="${boardPath(b)}"${b === view.board ? raw(' aria-current="page"') : ''}>${boardLabel(b)}</a>`,
        )}</nav>
        <p class="lock">Locks in ${countdown(view.nextCutoffAt, formatCountdown(view.nextCutoffAt))} at 3:12 ICT</p>
      </div>
    </div>
    <div class="rule-strip panel-box">
      <p><strong>Pay-to-win.</strong> The highest active bid ranks first. A bid on ${label} stays active for ${boardWindow(view.board)} from the moment the payment is confirmed.</p>
      <p><strong>Ties</strong> are broken by the owner's successful referrals, then valid clicks, then valid views (last 30 days).</p>
      <p class="rule-meta">Ranking policy ${view.rankingPolicyVersion}${lastLockLink(view.board, lastSnapshotDate)}</p>
    </div>
    <div class="panel" id="panel-${view.board}" data-board="${view.board}" data-poll="${view.board}" data-next-cutoff="${view.nextCutoffAt}">
${boardLists(view)}
    </div>
    <p class="ticker" data-ticker aria-live="polite">Rank updates the moment a payment is confirmed.</p>
    <div class="cta-row board-cta"><a class="btn btn-primary" href="/#agents">List your product ${icon('arrow')}</a><a class="btn btn-ghost" href="/#rules">Read the full rules</a></div>
  </div>
</section>`;
  return layout(ctx, body.toString());
}
