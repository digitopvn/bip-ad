// Refund Policy. Static, developer-authored text that must match the refund and chargeback path in
// ADR-0004 (a provider refund voids the contribution; partial refunds go to operator review) and the
// clawback in ADR-0005. Owner legal review is required before go-live: see legal-page-shell.ts.
import { html } from './html';
import { contactLink, legalPage } from './legal-page-shell';
import type { LayoutContext } from './types';

export function refundsPage(ctx: LayoutContext): string {
  const body = html`
<h2>1. Bids are all-pay</h2>
<p>Every confirmed bid on bip.ad is all-pay: you pay whether or not your product reaches the Top 10. You accept this on the checkout page before paying. For that reason we do <strong>not</strong> refund a bid because:</p>
<ul>
  <li>another bid passed yours (you were outbid);</li>
  <li>your product did not reach the Top 10 or a particular rank;</li>
  <li>you did not get the views, clicks, sign-ups, sales or other results you hoped for;</li>
  <li>you changed your mind after the bid became active.</li>
</ul>

<h2>2. When we do refund</h2>
<ul>
  <li><strong>Duplicate charges</strong>: you were charged more than once for the same checkout.</li>
  <li><strong>Technical errors</strong>: you were charged but, because of a fault on our side, the bid never became active on the board.</li>
  <li><strong>Where required</strong> by applicable law or by the payment provider's rules.</li>
</ul>
<p>Refunds go back through the provider you paid with (PayPal or SePay), in the original currency. Wallet balance spent on a bid is returned to your wallet, not paid out in cash.</p>

<h2>3. How to request a refund</h2>
<p>Email ${contactLink()} from the address on your account within 30 days of the payment. Include the checkout id and a short description of the problem. The checkout id starts with <code>bid_</code>; it is the last part of the checkout URL and the Bid ID in your receipt email.</p>

<h2>4. What a refund or chargeback changes</h2>
<ul>
  <li>When a full refund or a chargeback is confirmed by the provider, the bid's contribution is voided and its rank units are removed from the live board.</li>
  <li>A partial refund does not change the board automatically; the operator reviews it.</li>
  <li>Any referral commission earned from that payment is clawed back from the referrer.</li>
  <li>Published nightly snapshots are not rewritten. They remain the public record of the board at lock time.</li>
  <li>You receive an email confirming the reversal.</li>
</ul>

<h2>5. Disputes and buyer protection</h2>
<p>This policy does not remove any rights you have under your payment provider's terms, including PayPal Buyer Protection and PayPal's dispute process, or under the law where you live. We ask that you contact us first so we can try to resolve the problem quickly.</p>`;
  return legalPage(ctx, {
    id: 'refunds-title',
    title: 'Refund Policy',
    lede: 'When bip.ad refunds a bid, when it does not, and what happens to the board when a payment is reversed.',
    body,
  });
}
