// Privacy Policy. Static, developer-authored text that must match what the code stores:
// users (src/auth/session.ts), visitor hashes (src/domain/measurement.ts), encrypted payout
// beneficiaries (src/domain/wallet.ts), email groups (ADR-0009). Owner legal review is required
// before go-live: see legal-page-shell.ts.
import { html } from './html';
import { contactLink, LEGAL_OPERATOR, legalPage } from './legal-page-shell';
import type { LayoutContext } from './types';

export function privacyPage(ctx: LayoutContext): string {
  const body = html`
<h2>1. Who we are</h2>
<p>bip.ad is operated by ${LEGAL_OPERATOR}, which decides how the personal data described here is used. Contact us about privacy at ${contactLink()}.</p>

<h2>2. Data we collect</h2>
<ul>
  <li><strong>Account profile.</strong> When you sign in with GitHub or Google we receive and store your display name, avatar URL, email address (when the provider shares it) and the provider's account id. We never receive your GitHub or Google password.</li>
  <li><strong>Product content.</strong> The listings, page blocks and links your agent submits, their version history, and the moderation scores and decisions about them. Published products, boards and snapshots are public.</li>
  <li><strong>Payment records.</strong> Bid quotes, amounts, currencies, exchange rates, provider payment ids and their status, refunds and chargebacks, as reported by PayPal or SePay. Card and bank details are entered on the provider's side; bip.ad never sees them.</li>
  <li><strong>Views and clicks.</strong> To count valid unique views and clicks we derive a pseudonymous visitor identifier by hashing your IP address (for IPv6, its /64 network) with a secret key and the current ICT date, so the identifier changes every day. We store the hash, not the IP address. Known bots are ignored, and your own views of your products are not counted.</li>
  <li><strong>Referrals.</strong> Referral links you share, the accounts that signed up through them, and the commissions they earned.</li>
  <li><strong>Payout details.</strong> If you request a payout, the beneficiary details you provide are encrypted (AES-GCM) before storage and are decrypted only for the operator preparing the transfer, together with the transfer reference and proof.</li>
  <li><strong>Email records.</strong> Which transactional emails were sent to you, their delivery status, and your email preferences.</li>
</ul>

<h2>3. Cookies</h2>
<ul>
  <li><code>bip_session</code>: keeps you signed in for up to 30 days. Required.</li>
  <li><code>bip_ref</code>: a signed cookie that remembers the referral link you followed, for up to 30 days, so the referrer can be credited if you sign up. It is cleared when you sign in.</li>
  <li><code>bip_oauth_state</code>: a short-lived (10 minute) cookie that protects the sign-in flow.</li>
</ul>
<p>We use no advertising or third-party analytics cookies.</p>

<h2>4. How we use data</h2>
<ul>
  <li>To run your account, publish and moderate products, rank boards and lock snapshots.</li>
  <li>To take payments, keep a double-entry ledger, reconcile with providers and handle refunds and disputes.</li>
  <li>To credit referrals, run your wallet and make payouts.</li>
  <li>To detect fraud, invalid traffic and abuse, and to keep the service secure.</li>
  <li>To send the emails described below, and to meet legal, tax and accounting obligations.</li>
</ul>

<h2>5. Service providers</h2>
<ul>
  <li><strong>Cloudflare</strong>: hosting (Workers), databases (D1 and KV), AI moderation models (Workers AI) and email sending (Email Service).</li>
  <li><strong>PayPal</strong> and <strong>SePay</strong>: payment processing, under their own privacy policies.</li>
  <li><strong>GitHub</strong> and <strong>Google</strong>: sign-in.</li>
</ul>
<p>Product content, including the landing page we fetch for moderation, is sent to the AI models to score it. We do not sell personal data.</p>

<h2>6. Emails</h2>
<p>We send transactional email in English: a welcome, product moderation decisions, bid receipts and reversals, nightly board lock results, available commissions and paid payouts. You can switch off the optional groups (Products, Boards and Referrals) on <a href="/account#email">your account page</a> or with the one-click unsubscribe link in each email. Receipts, reversals, payouts and account emails are always sent because they concern your money or account.</p>

<h2>7. Retention</h2>
<p>We keep account, product and email records while your account exists. Payment, ledger and payout records are kept as long as accounting, tax and dispute rules require. Published snapshots are permanent public records. Visitor hashes are kept as measurement history; ranking only uses the last 30 days.</p>

<h2>8. Your rights</h2>
<p>Depending on where you live, you may have the right to access, correct, export or delete your personal data, or to object to some uses. Email ${contactLink()} from the address on your account. We will delete or anonymise data we are not required to keep; records we must keep for payments, accounting or fraud prevention, and published snapshots, are kept but are not used for anything else.</p>

<h2>9. Changes</h2>
<p>We may update this policy. The effective date at the top shows the current version.</p>`;
  return legalPage(ctx, {
    id: 'privacy-title',
    title: 'Privacy Policy',
    lede: 'What bip.ad collects, why, who processes it, and how to reach us about your data.',
    body,
  });
}
