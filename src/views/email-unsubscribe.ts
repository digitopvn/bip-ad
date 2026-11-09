// Unsubscribe pages. GET only confirms (link scanners must not unsubscribe anyone); the button POSTs.
import { html } from './html';
import { layout } from './layout';
import type { LayoutContext } from './types';

export type UnsubscribeScope = 'products' | 'boards' | 'referrals' | 'all';

const SCOPE_LABEL: Record<UnsubscribeScope, string> = {
  products: 'product moderation emails',
  boards: 'board lock results emails',
  referrals: 'referral commission emails',
  all: 'all optional emails (products, boards and referrals)',
};

export function unsubscribeConfirmPage(ctx: LayoutContext, scope: UnsubscribeScope, actionUrl: string): string {
  const body = html`<section class="section-tight" aria-labelledby="unsub-title">
  <div class="wrap narrow">
    <p class="kicker">Email</p>
    <h1 class="h2" id="unsub-title">Stop ${SCOPE_LABEL[scope]}?</h1>
    <p class="section-lede">Receipts, refunds, payouts and account emails are always sent. You can switch groups back on from your account page.</p>
    <form method="post" action="${actionUrl}">
      <button class="btn btn-primary" type="submit">Unsubscribe</button>
    </form>
  </div>
</section>`;
  return layout(ctx, body.toString());
}

export function unsubscribeDonePage(ctx: LayoutContext, scope: UnsubscribeScope): string {
  const body = html`<section class="section-tight" aria-labelledby="unsub-title">
  <div class="wrap narrow">
    <p class="kicker">Email</p>
    <h1 class="h2" id="unsub-title">You are unsubscribed</h1>
    <p class="section-lede">We will no longer send you ${SCOPE_LABEL[scope]}. Change this any time on <a href="/account#email">your account page</a>.</p>
  </div>
</section>`;
  return layout(ctx, body.toString());
}
