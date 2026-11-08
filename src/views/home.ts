// Homepage ("Open Studio"): split hero with the 3:12 → BIP morph, the three-board gallery,
// then Why 3:12, For agents, Rules, Transparency, FAQ and the final countdown.
import { boardLists, boardPath, copyField, countdown, icon, lastLockLink } from './components';
import { BOARDS, boardLabel, formatCountdown } from './format';
import { html, raw, type SafeHtml } from './html';
import { layout } from './layout';
import { MORPH_SVG } from './morph';
import type { BoardCode, BoardView, HomeView, LayoutContext } from './types';

function tabs(active: BoardCode): SafeHtml {
  return html`<nav class="tabs" aria-label="Choose a board" data-tabs>${BOARDS.map(
    (b) =>
      html`<a class="tab" id="tab-${b}" href="${boardPath(b)}" data-board="${b}" data-panel="panel-${b}"${
        b === active ? raw(' aria-current="true"') : ''
      }>${boardLabel(b)}</a>`,
  )}</nav>`;
}

function panel(view: BoardView, active: boolean, lastDate: string | undefined): SafeHtml {
  return html`<div class="panel" id="panel-${view.board}" data-board="${view.board}" data-poll="${view.board}" data-next-cutoff="${view.nextCutoffAt}"${
    active ? '' : raw(' hidden')
  }>
${boardLists(view)}
<p class="panel-foot"><a class="cut-link" href="${boardPath(view.board)}">Open the full ${boardLabel(view.board)} board ${icon('arrow')}</a>${lastLockLink(view.board, lastDate)}</p>
</div>`;
}

const hero = (): SafeHtml => html`<section class="hero" id="top">
  <div class="wrap hero-grid">
    <div class="morph" data-morph>
      <div class="morph-stage" data-morph-stage>${MORPH_SVG}</div>
      <p class="morph-caption"><button class="morph-toggle" type="button" data-morph-toggle aria-pressed="false" aria-label="Read 3:12 as BIP"><span class="mt-a">3:12</span>${icon('swap')}<span class="mt-b">BIP</span></button><span>Read it like a display: <b>B</b>uild <b>I</b>n <b>P</b>ublic.</span></p>
    </div>
    <div class="hero-copy">
      <h1>The launch board that locks at 3:12.</h1>
      <p class="lede">Builders list products through their AI agents and bid openly for a seat. Every night the Top 10 becomes a video on X, Facebook and YouTube.</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="#agents">List your product ${icon('arrow')}</a>
        <a class="btn btn-ghost" href="#board">See tonight's board ${icon('down')}</a>
      </div>
    </div>
  </div>
</section>`;

function boardSection(view: HomeView): SafeHtml {
  const activeView = view.boards[view.active];
  const anySample = BOARDS.some((b) => view.boards[b].rows.some((r) => r.isSample));
  return html`<section class="board-sec" id="board" aria-labelledby="board-title">
  <div class="wrap">
    <div class="board-head">
      <div>
        <h2 id="board-title">Tonight's board</h2>
        <p class="board-sub">Ranked by active bid. Paid placement, never a rating of quality.${
          anySample ? html` <span class="sample">Includes sample listings</span>` : ''
        }</p>
      </div>
      <div class="board-ctrl">
        ${tabs(view.active)}
        <p class="lock">Locks in ${countdown(activeView.nextCutoffAt, formatCountdown(activeView.nextCutoffAt))} at 3:12 ICT</p>
      </div>
    </div>
${BOARDS.map((b) => panel(view.boards[b], b === view.active, view.lastSnapshotDate[b]))}
    <p class="ticker" data-ticker aria-live="polite">Rank updates the moment a payment is confirmed.</p>
  </div>
</section>`;
}

const why = (): SafeHtml => html`<section class="section" id="why" aria-labelledby="why-title">
  <div class="wrap">
    <div class="panel-box why">
      <div class="why-head">
        <div>
          <p class="kicker">Why 3:12</p>
          <h2 class="h2" id="why-title">Squint at the clock. It says BIP.</h2>
        </div>
        <p class="section-lede">BIP is Build In Public, the habit this board is made for. 3:12 is also the moment that counts: every board locks into a permanent record, and the Top 10 goes into that night's video.</p>
      </div>
      <ol class="equation" aria-label="How 3:12 becomes BIP">
        <li class="eq"><span class="eq-glyphs" aria-hidden="true"><span class="eq-d" data-d="3"></span><span class="eq-l">B</span></span><span class="eq-t"><strong>3 becomes B</strong>Add a stem on the left.</span></li>
        <li class="eq"><span class="eq-glyphs" aria-hidden="true"><span class="eq-d" data-d="1"></span><span class="eq-l">I</span></span><span class="eq-t"><strong>1 is already I</strong>Nothing changes.</span></li>
        <li class="eq"><span class="eq-glyphs" aria-hidden="true"><span class="eq-d" data-d="2"></span><span class="eq-l">P</span></span><span class="eq-t"><strong>2 becomes P</strong>Fold the base up into a stem.</span></li>
      </ol>
      <p class="bip-line"><span>B</span>uild <span>I</span>n <span>P</span>ublic.</p>
      <ul class="facts">
        <li><strong>One lock, three boards.</strong>Daily, Weekly and Monthly snapshot together at 3:12 ICT.</li>
        <li><strong>Snapshots never change.</strong>Each night is kept as a permanent record you can link to.</li>
        <li><strong>The clock is strict.</strong>A payment confirmed at 3:13 moves you now and counts for the next night's video.</li>
      </ul>
    </div>
  </div>
</section>`;

function agents(mcpUrl: string): SafeHtml {
  return html`<section class="section" id="agents" aria-labelledby="agents-title">
  <div class="wrap agent-grid">
    <div>
      <p class="kicker">For agents</p>
      <h2 class="h2" id="agents-title">Your agent does the listing. You approve the money.</h2>
      <ol class="steps">
        <li><span><strong>Connect.</strong> Add bip.ad to Claude, ChatGPT or any MCP client and sign in once with GitHub or Google.</span></li>
        <li><span><strong>List.</strong> Your agent builds the page from safe widgets. Moderation reviews it before it goes live.</span></li>
        <li><span><strong>Bid.</strong> It quotes a Lucky Boost. You approve the payment in PayPal or SePay.</span></li>
      </ol>
      ${copyField('mcp-endpoint', mcpUrl, 'Copy the MCP server URL')}
      <p class="endpoint-note">Products are created and edited only through MCP. The website never asks you to fill in a listing form.</p>
    </div>
    <figure class="panel-box chat" aria-label="Example conversation with an AI agent using bip.ad">
      <div class="chat-top"><img src="/img/bip-mark.webp" alt="" width="26" height="24"><b>bip.ad</b> connected over MCP</div>
      <div class="msg you"><p>Get Tidy Inbox into the Daily Top 2 on bip.ad.</p></div>
      <div class="msg agent"><p>Tidy Inbox is #3 on Daily with $367.50 active. A $25.00 Lucky Boost puts it at #2, ahead of Formwise at $388.50. It is all-pay and non-refundable if you are outbid later. Approve?</p><span class="tools"><code>boards.get</code><code>boosts.quote</code></span></div>
      <div class="msg you"><p>Approve with PayPal.</p></div>
      <div class="msg agent"><p>Here is your checkout link. I will confirm once PayPal verifies the payment.</p><span class="tools"><code>boosts.checkout</code></span></div>
      <div class="msg agent ok"><p>Payment confirmed. Tidy Inbox is #2 on Daily, active for the next 24 hours.</p><span class="tools"><code>boosts.status</code></span></div>
      <figcaption class="chat-note">Example conversation with sample products.</figcaption>
    </figure>
  </div>
</section>`;
}

const rules = (): SafeHtml => html`<section class="section" id="rules" aria-labelledby="rules-title">
  <div class="wrap">
    <p class="kicker">Rules</p>
    <h2 class="h2" id="rules-title">Pay-to-win, and we say so up front.</h2>
    <p class="section-lede">The highest active bid always ranks first. Everything else only breaks ties. Every confirmed bid is kept, win or lose.</p>
    <div class="rules-grid">
      <div class="panel-box">
        <ol class="ladder">
          <li><span>Highest active bid</span><span>Always decides</span></li>
          <li><span>Owner's successful referrals</span><span>Ties only</span></li>
          <li><span>Valid unique clicks, last 30 days</span><span>Ties only</span></li>
          <li><span>Valid unique views, last 30 days</span><span>Ties only</span></li>
          <li><span>First to reach the amount</span><span>Ties only</span></li>
        </ol>
        <p class="ladder-note">A $10 bid with no referrals still ranks above a $9 bid with 100 referrals. Free listings always sit below paid ones.</p>
      </div>
      <div class="panel-box side">
        <div>
          <h3>What a bid buys</h3>
          <ul class="list-check yes">
            <li>${icon('check')}A higher seat while your bid is active</li>
            <li>${icon('check')}A place in the video if you hold the Top 10 at 3:12</li>
            <li>${icon('check')}Reach from your board's shared ads fund</li>
          </ul>
        </div>
        <div>
          <h3>What it never buys</h3>
          <ul class="list-check no">
            <li>${icon('cross')}Guaranteed impressions, clicks or sales</li>
            <li>${icon('cross')}Keeping your seat until the lock</li>
            <li>${icon('cross')}A refund for being outbid</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</section>`;

const money = (): SafeHtml => html`<section class="section" id="money" aria-labelledby="money-title">
  <div class="wrap money-grid">
    <div>
      <p class="kicker">Transparency</p>
      <h2 class="h2" id="money-title">80% of every bid buys ads for its own board.</h2>
      <p class="section-lede">Daily money never pays for Weekly ads. Spend caps live in code, and every spend is published with its source and evidence.</p>
    </div>
    <figure>
      <div class="split-bar" role="img" aria-label="Split of eligible bid revenue: 80% ads fund, 5% referral commission, 15% platform">
        <span class="seg-bar seg-ads">80%</span><span class="seg-bar seg-ref"></span><span class="seg-bar seg-plat"></span>
      </div>
      <figcaption class="legend">
        <div><span class="pct">80%</span><p>Ads fund for the same board, flown over 1, 7 or 30 days.</p></div>
        <div><span class="pct">5%</span><p>Referral commission, spendable on bids or withdrawn monthly.</p></div>
        <div><span class="pct">15%</span><p>Platform and payment costs. 20% when no referral applies.</p></div>
      </figcaption>
    </figure>
  </div>
</section>`;

const faqItem = (q: string, a: string): SafeHtml =>
  html`<details><summary>${q}${icon('plus')}</summary><p>${a}</p></details>`;

const faq = (): SafeHtml => html`<section class="section" id="faq" aria-labelledby="faq-title">
  <div class="wrap faq-grid">
    <h2 class="h2" id="faq-title">Before you bid.</h2>
    <div class="faq">
      ${faqItem('Do I get money back if I am outbid?', 'No. bip.ad is all-pay: every confirmed bid is kept, even if it finishes outside the Top 10. Refunds cover only failed or duplicate payments, fraud, legal requirements or our own error.')}
      ${faqItem('Does a bid guarantee traffic or sales?', 'No. A bid buys position while it is active. Impressions, clicks and sales are never guaranteed, and the ads fund is shared by the whole board.')}
      ${faqItem('How long does a bid stay active?', 'From the moment the payment is confirmed: 24 hours on Daily, 7 days on Weekly and 30 days on Monthly. Each extra bid is its own contribution and expires on its own clock.')}
      ${faqItem('Which payments do you accept?', 'PayPal in USD and SePay in VND with VietQR. Your rank moves only after the provider confirms the payment through a verified webhook, never from a redirect or a screenshot.')}
      ${faqItem('How are referral commissions paid out?', 'Ask your agent to call payouts.request for your available balance. Requests are transferred manually during days 01 to 10 of each month, after the beneficiary and amount are checked.')}
      ${faqItem('Can free products appear on the board?', "Yes, always below paid ones, ordered by the owner's successful referrals, then valid clicks, then valid views. If fewer than ten products have bids, free products fill the Top 10.")}
    </div>
  </div>
</section>`;

function finalCta(target: string): SafeHtml {
  return html`<section class="final" aria-labelledby="final-title">
  <div class="wrap">
    <p class="final-lock">Next BIP in ${countdown(target, formatCountdown(target))}</p>
    <h2 id="final-title">Build in public. Bid to win.</h2>
    <div class="cta-row"><a class="btn btn-primary" href="#agents">List your product ${icon('arrow')}</a><a class="btn btn-ghost" href="#board">Back to the board</a></div>
  </div>
</section>`;
}

export function homePage(ctx: LayoutContext, view: HomeView): string {
  const target = view.boards[view.active].nextCutoffAt;
  const body = html`${hero()}
${boardSection(view)}
${why()}
${agents(view.mcpUrl)}
${rules()}
${money()}
${faq()}
${finalCta(target)}`;
  return layout(ctx, body.toString());
}
