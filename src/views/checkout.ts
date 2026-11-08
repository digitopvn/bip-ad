// Hosted checkout step for a bid intent created by an agent. The human owner approves payment here.
// Each payment option is its own POST form carrying csrf, method and a required all-pay acknowledgement.
import { icon, notice, productHref } from './components';
import { boardLabel, boardWindow, formatIctDateTime, formatMoney, formatRankUnits } from './format';
import { html, seg, type SafeHtml } from './html';
import { layout } from './layout';
import type { CheckoutView, LayoutContext } from './types';

type Method = 'paypal' | 'sepay' | 'wallet';

const CONFIRMED = new Set(['confirmed']);
const CLOSED = new Set(['expired', 'failed', 'cancelled', 'canceled']);
const PAYABLE = new Set(['awaiting_payment']);

function methodLabel(method: Method, mode: CheckoutView['paymentMode']): string {
  if (method === 'wallet') return 'Pay with wallet balance';
  const name = method === 'paypal' ? 'PayPal' : 'SePay VietQR';
  if (mode === 'simulated') return `Simulate ${name} payment (test)`;
  if (mode === 'sandbox') return `Pay with ${name} (sandbox)`;
  return `Pay with ${name}`;
}

function payForm(view: CheckoutView, method: Method, amount: string): SafeHtml {
  const ackId = `ack-${method}`;
  return html`<form class="pay-form panel-box" method="post" action="/checkout/${seg(view.intentId)}/pay">
  <input type="hidden" name="csrf" value="${view.csrf}">
  <input type="hidden" name="method" value="${method}">
  <label class="ack" for="${ackId}"><input type="checkbox" id="${ackId}" name="all_pay_ack" value="1" required><span>I understand the all-pay terms above.</span></label>
  <button class="btn btn-primary" type="submit">${methodLabel(method, view.paymentMode)} ${icon('arrow')}</button>
  <p class="pay-amt">Charges <strong>${amount}</strong></p>
</form>`;
}

function outcome(view: CheckoutView): SafeHtml | '' {
  const status = view.status.toLowerCase();
  if (CONFIRMED.has(status)) {
    return notice(
      'ok',
      html`<strong>Payment confirmed.</strong> ${view.productName} now has this bid active on ${boardLabel(view.board)} for ${boardWindow(
        view.board,
      )}. <a href="/${view.board}">See the live board</a>.`,
    );
  }
  if (CLOSED.has(status)) {
    return notice(
      'warn',
      html`<strong>This checkout is ${status === 'canceled' ? 'cancelled' : status}.</strong> No payment was taken. Ask your agent for a new quote with <code>boosts.quote</code>.`,
    );
  }
  if (!PAYABLE.has(status)) {
    return notice('info', html`Checkout status: <strong>${status.replace(/_/g, ' ')}</strong>.`);
  }
  return '';
}

function payArea(view: CheckoutView): SafeHtml {
  const status = view.status.toLowerCase();
  if (!PAYABLE.has(status)) return html``;
  if (!view.isOwner) {
    return html`<div class="panel-box pay-locked"><p>Sign in as the product owner to pay.</p><a class="btn btn-primary btn-sm" href="/login?next=${encodeURIComponent(
      `/checkout/${view.intentId}`,
    )}">Sign in</a></div>`;
  }
  if (view.dueMinor <= 0) {
    return html`<div class="pay-options">${payForm(view, 'wallet', formatMoney(view.quoteCurrency, view.walletAppliedMinor))}</div>`;
  }
  if (!view.providers.length) {
    return notice('error', 'No payment provider accepts this currency right now. Ask your agent for a quote in another currency.', 'alert');
  }
  const due = formatMoney(view.quoteCurrency, view.dueMinor);
  return html`<div class="pay-options">${view.providers.map((p) => payForm(view, p, due))}</div>`;
}

export function checkoutPage(ctx: LayoutContext, view: CheckoutView): string {
  const board = boardLabel(view.board);
  const rows: [string, SafeHtml | string][] = [
    ['Product', html`<a href="${productHref(view.productSlug)}">${view.productName}</a>`],
    ['Board', board],
    ['Bid', `${formatRankUnits(view.rankUnits)} in rank units`],
    ['Quote', formatMoney(view.quoteCurrency, view.quoteMinor)],
  ];
  if (view.walletAppliedMinor > 0) rows.push(['Wallet applied', `-${formatMoney(view.quoteCurrency, view.walletAppliedMinor)}`]);
  rows.push(['Due now', html`<strong>${formatMoney(view.quoteCurrency, Math.max(0, view.dueMinor))}</strong>`]);
  if (view.fxRate !== null) rows.push(['Exchange rate', String(view.fxRate)]);
  rows.push(['Active window', `${boardWindow(view.board)} from confirmation`]);
  rows.push(['Projected rank', `#${view.projectedRank} on ${board} if paid now`]);
  rows.push(['Quote valid until', formatIctDateTime(view.quoteExpiresAt)]);

  const body = html`<section class="section-tight checkout" aria-labelledby="co-title">
  <div class="wrap narrow">
    <p class="kicker">Checkout</p>
    <h1 class="h2" id="co-title">Approve a ${board} bid for ${view.productName}</h1>
    ${view.message ? notice('info', view.message) : ''}
    ${outcome(view)}
    <div class="co-grid">
      <dl class="panel-box co-summary">${rows.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
      <div class="co-side">
        <div class="all-pay" role="note"><strong>All-pay:</strong> you pay whether or not you reach the Top 10. No refunds for being outbid. No guaranteed results.</div>
        <p class="muted">Pay-to-win: the highest active bid ranks first and other bids can pass yours at any time. Your rank moves only after the provider confirms the payment.</p>
        ${payArea(view)}
      </div>
    </div>
  </div>
</section>`;
  return layout(ctx, body.toString());
}
