// Account overview. Read-only on the web: products are edited and payouts requested through MCP.
import { boardPath, copyField, productHref } from './components';
import { boardLabel, formatIctDateTime, formatMoney, formatMoneyLine, formatRankUnits, formatSignedMoney, plural } from './format';
import { html, imageUrl, type SafeHtml } from './html';
import { layout } from './layout';
import type { AccountView, LayoutContext, MoneyLine } from './types';

function tableOrEmpty(rows: SafeHtml[], head: SafeHtml, empty: string, caption: string): SafeHtml {
  if (!rows.length) return html`<p class="muted">${empty}</p>`;
  return html`<div class="table-wrap"><table class="data-table"><caption class="sr-only">${caption}</caption><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

function walletTable(w: AccountView['wallet']): SafeHtml {
  const columns: [string, MoneyLine[]][] = [
    ['Pending', w.pending],
    ['Available', w.available],
    ['Reserved for bids', w.reservedForBid],
    ['Reserved for payout', w.reservedForPayout],
    ['Paid out', w.paid],
  ];
  const currencies = [...new Set(columns.flatMap(([, lines]) => lines.map((l) => l.currency.toUpperCase())))].sort();
  if (!currencies.length) return html`<p class="muted">No commission yet. You earn 5% when someone you referred makes their first confirmed bid.</p>`;
  const amount = (lines: MoneyLine[], currency: string): string => {
    const total = lines.filter((l) => l.currency.toUpperCase() === currency).reduce((sum, l) => sum + l.minor, 0);
    return formatMoney(currency, total);
  };
  return html`<div class="table-wrap"><table class="data-table"><caption class="sr-only">Wallet balances per currency</caption><thead><tr><th scope="col">Currency</th>${columns.map(
    ([label]) => html`<th scope="col" class="num">${label}</th>`,
  )}</tr></thead><tbody>${currencies.map(
    (c) => html`<tr><th scope="row">${c}</th>${columns.map(([, lines]) => html`<td class="num">${amount(lines, c)}</td>`)}</tr>`,
  )}</tbody></table></div>`;
}

const sectionNav = (): SafeHtml =>
  html`<nav class="acct-nav" aria-label="Account sections"><a href="#products">Products</a><a href="#payments">Payments</a><a href="#referrals">Referrals</a><a href="#wallet">Wallet</a><a href="#payouts">Payouts</a><a href="#mcp">MCP</a></nav>`;

export function accountPage(ctx: LayoutContext, view: AccountView): string {
  const avatar = imageUrl(view.viewer.avatarUrl);
  const products = view.products.length
    ? html`<ul class="acct-products">${view.products.map(
        (p) =>
          html`<li class="panel-box"><div class="ap-head"><h3><a href="${productHref(p.slug)}">${p.name}</a></h3><span class="pill">${p.status.replace(/_/g, ' ')}</span></div><ul class="ap-standings">${p.standings.map(
            (s) =>
              html`<li><a href="${boardPath(s.board)}">${boardLabel(s.board)}</a><span>${s.rank === null ? 'Not ranked' : `#${s.rank}`}</span><span>${
                s.activeRankUnits > 0 ? formatRankUnits(s.activeRankUnits) : 'Free'
              }</span></li>`,
          )}</ul></li>`,
      )}</ul>`
    : html`<p class="muted">No products yet. Ask your agent to call <code>products.create</code> over MCP.</p>`;

  const payments = tableOrEmpty(
    view.payments.map(
      (p) =>
        html`<tr><td>${formatIctDateTime(p.createdAt)}</td><td>${p.productName}</td><td>${boardLabel(p.board)}</td><td class="num">${formatMoney(
          p.currency,
          p.amountMinor,
        )}</td><td>${p.provider}</td><td><span class="pill">${p.state.replace(/_/g, ' ')}</span></td></tr>`,
    ),
    html`<tr><th scope="col">Date</th><th scope="col">Product</th><th scope="col">Board</th><th scope="col" class="num">Amount</th><th scope="col">Provider</th><th scope="col">State</th></tr>`,
    'No payments yet.',
    'Payments',
  );

  const history = tableOrEmpty(
    view.walletHistory.map(
      (h) =>
        html`<tr><td>${formatIctDateTime(h.at)}</td><td>${h.memo}</td><td class="num${h.deltaMinor < 0 ? ' neg' : ''}">${formatSignedMoney(
          h.currency,
          h.deltaMinor,
        )}</td></tr>`,
    ),
    html`<tr><th scope="col">Date</th><th scope="col">Entry</th><th scope="col" class="num">Change</th></tr>`,
    'No wallet activity yet.',
    'Wallet history',
  );

  const payouts = tableOrEmpty(
    view.payouts.map(
      (p) =>
        html`<tr><td>${formatIctDateTime(p.requestedAt)}</td><td class="num">${formatMoney(p.currency, p.requestedMinor)}</td><td><span class="pill">${p.state.replace(
          /_/g,
          ' ',
        )}</span></td><td>${p.transferReference ? html`<code>${p.transferReference}</code>` : html`<span class="muted">Not transferred yet</span>`}</td></tr>`,
    ),
    html`<tr><th scope="col">Requested</th><th scope="col" class="num">Amount</th><th scope="col">State</th><th scope="col">Transfer reference</th></tr>`,
    'No payout requests yet.',
    'Payout requests',
  );

  const sum = (lines: MoneyLine[]): string => (lines.length ? lines.map(formatMoneyLine).join(' · ') : '0');

  const body = html`<section class="section-tight account" aria-labelledby="acct-title">
  <div class="wrap">
    <header class="acct-head">
      ${avatar ? html`<img class="avatar" src="${avatar}" alt="" width="56" height="56" referrerpolicy="no-referrer">` : ''}
      <div><p class="kicker">Account</p><h1 class="h2" id="acct-title">${view.viewer.displayName}</h1></div>
    </header>
    ${sectionNav()}

    <section class="acct-sec" id="products" aria-labelledby="products-title">
      <h2 id="products-title">Products</h2>
      <p class="muted">Read-only here. Edit through your agent over MCP: <code>pages.set_blocks</code>, then <code>pages.publish</code> for review.</p>
      ${products}
    </section>

    <section class="acct-sec" id="payments" aria-labelledby="payments-title">
      <h2 id="payments-title">Payments</h2>
      <p class="muted">All-pay: confirmed bids are kept whether or not they reach the Top 10.</p>
      ${payments}
    </section>

    <section class="acct-sec" id="referrals" aria-labelledby="referrals-title">
      <h2 id="referrals-title">Referrals</h2>
      <p class="muted">You earn 5% commission when someone you referred makes their first confirmed bid. Successful referrals also break ties between equal bids on all your products.</p>
      <div class="acct-cards">
        <div class="panel-box stat"><span class="stat-k">Successful</span><span class="stat-v">${view.referral.successful}</span></div>
        <div class="panel-box stat"><span class="stat-k">Pending</span><span class="stat-v">${view.referral.pending}</span></div>
        <div class="panel-box stat"><span class="stat-k">Your code</span><span class="stat-v mono">${view.referral.code}</span></div>
      </div>
      ${copyField('referral-link', view.referral.link, 'Copy your referral link')}
    </section>

    <section class="acct-sec" id="wallet" aria-labelledby="wallet-title">
      <h2 id="wallet-title">Wallet</h2>
      <p class="muted">Available now: <strong>${sum(view.wallet.available)}</strong>. Use it for bids at checkout or request a payout.</p>
      ${walletTable(view.wallet)}
      <h3 class="acct-h3">History</h3>
      ${history}
    </section>

    <section class="acct-sec" id="payouts" aria-labelledby="payouts-title">
      <h2 id="payouts-title">Payouts</h2>
      <p class="muted">Ask your agent to call <code>payouts.request</code> for your available balance. Requests are transferred manually on days 01–10 of each month, after the beneficiary and amount are checked. ${plural(
        view.payouts.length,
        'request',
        'requests',
      )} so far.</p>
      ${payouts}
    </section>

    <section class="acct-sec" id="mcp" aria-labelledby="mcp-title">
      <h2 id="mcp-title">Connect your agent</h2>
      <ol class="steps">
        <li><span><strong>Add the server.</strong> In Claude, ChatGPT or any MCP client, add a remote MCP server with this URL.</span></li>
        <li><span><strong>Sign in.</strong> Approve access with the same GitHub or Google account you use here.</span></li>
        <li><span><strong>Ask.</strong> For example: "List my product on bip.ad" or "Quote a Daily boost to reach the Top 3".</span></li>
      </ol>
      ${copyField('mcp-endpoint', view.mcpUrl, 'Copy the MCP server URL')}
    </section>
  </div>
</section>`;
  return layout(ctx, body.toString());
}
