// Terms of Service. Static, developer-authored text; must match how the code behaves
// (all-pay bids, MCP-only product creation, ADR-0004 refunds, ADR-0005 referrals and payouts,
// ADR-0008 moderation). Owner legal review is required before go-live: see legal-page-shell.ts.
import { html } from './html';
import { contactLink, LEGAL_OPERATOR, legalPage } from './legal-page-shell';
import type { LayoutContext } from './types';

export function termsPage(ctx: LayoutContext): string {
  const body = html`
<h2>1. What bip.ad is</h2>
<p>bip.ad is a build-in-public launch board operated by ${LEGAL_OPERATOR}. Builders list products and bid openly for a place on three public boards: Daily, Weekly and Monthly. Every night at 03:12 ICT (UTC+7) each board's Top 10 is locked into a public snapshot.</p>
<p>Products are created and edited only through our MCP server, by an AI agent acting for a signed-in account. The website itself has no form to create or edit products.</p>

<h2>2. Accounts</h2>
<ul>
  <li>You sign in with GitHub or Google. You must be old enough to enter a binding contract where you live, and you are responsible for everything done through your account and through any agent you connect to it.</li>
  <li>Keep your GitHub or Google account secure. Access to bip.ad follows that account, and we cannot recover it for you.</li>
</ul>

<h2>3. Your content and moderation</h2>
<ul>
  <li>You keep ownership of the product listings, page content and media links you submit. You give us a worldwide, non-exclusive, royalty-free licence to host, display, rank, snapshot and promote them on bip.ad and in the board videos and posts we publish.</li>
  <li>You must have the right to publish your content. It must be accurate and lawful, and it must not be a scam, fraud, phishing, malware, impersonation, or an attempt to manipulate our systems or reviewers, including prompt injection. Listings for gambling, adult content, financial speculation (such as tokens or trading signals), weapons or drugs are never approved automatically and may be refused.</li>
  <li>Every submission and edit is screened automatically and scored by AI models. Low-risk changes may publish automatically; anything else waits for a human operator. AI scores are signals only; they never reject a product on their own.</li>
  <li>The operator may approve, reject or suspend a product at any time, and may suspend accounts that break these terms. Suspended products cannot be edited or resubmitted.</li>
</ul>

<h2>4. Paid bids: all-pay and pay-to-win</h2>
<ul>
  <li><strong>Ranking is paid placement, not a rating of quality.</strong> The highest active bid ranks first. Ties are broken by successful referrals, then valid unique clicks, then valid unique views.</li>
  <li><strong>All-pay:</strong> you pay for a confirmed bid whether or not your product reaches the Top 10. Other bids can pass yours at any time. You must accept these terms on the checkout page before paying.</li>
  <li>A bid counts for a rolling window from the moment the payment provider confirms it: 1 day on Daily, 7 days on Weekly and 30 days on Monthly. Your rank moves only after confirmation.</li>
  <li>We do not guarantee any rank, impressions, views, clicks, sign-ups, sales, coverage or other results.</li>
  <li>Refunds are limited and are described in our <a href="/refunds">Refund Policy</a>.</li>
</ul>

<h2>5. Payments</h2>
<p>Payments are taken by third-party providers: PayPal in US dollars and SePay (VietQR bank transfer) in Vietnamese dong, when each provider is available for the quoted currency. Each provider's own terms also apply. We never see or store your card or bank login details. Quotes are valid for a limited time; an expired quote must be requested again.</p>

<h2>6. Referrals, wallet and payouts</h2>
<ul>
  <li>Your referral link earns a commission of 5% of the external-cash part of the first confirmed bid of each account you refer. There is no lifetime commission. Self-referrals and accounts using your own email address do not qualify.</li>
  <li>A commission is held for 30 days before it becomes available. If the underlying payment is refunded or charged back, the commission is clawed back, first from pending and then from available balance; any remainder is recorded as an amount you owe.</li>
  <li>Available commission can be spent on bids from your wallet. Wallet funds cannot be transferred to other users.</li>
  <li>Payouts are made manually by bank transfer on days 01–10 of each month (ICT), above a minimum amount. Before paying, the operator may verify the beneficiary, the amount and any tax or identity requirements, and may hold a payout while it checks for fraud. Commissions from test or simulated payments are never payable.</li>
</ul>

<h2>7. Snapshots</h2>
<p>Each nightly snapshot is a permanent public record of the board at lock time. Later bids, refunds, referrals or metrics do not rewrite a published snapshot.</p>

<h2>8. Acceptable use</h2>
<p>Do not inflate views or clicks with bots or paid traffic schemes, abuse referrals, probe or disrupt the service, or use it to break the law. We may discard invalid traffic, void referrals and suspend accounts involved in abuse.</p>

<h2>9. Disclaimers and limitation of liability</h2>
<p>bip.ad is provided "as is" and "as available". To the fullest extent the law allows, ${LEGAL_OPERATOR} is not liable for indirect, incidental or consequential losses, lost profits or lost data, and our total liability for any claim is limited to the amount you paid us in the 3 months before the claim. Nothing in these terms limits liability that cannot be limited by law.</p>

<h2>10. Changes to these terms</h2>
<p>We may update these terms. The effective date at the top shows the current version. Material changes apply from the date they are published and do not affect bids confirmed before that date. Continuing to use bip.ad after a change means you accept it.</p>

<h2>11. Contact</h2>
<p>Questions about these terms: ${contactLink()}.</p>`;
  return legalPage(ctx, {
    id: 'terms-title',
    title: 'Terms of Service',
    lede: 'The rules for listing products, bidding and earning referral commission on bip.ad.',
    body,
  });
}
