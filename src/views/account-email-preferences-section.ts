// "Email" section of /account: the address on file and the three opt-out groups, saved by a CSRF-protected POST.
import { html, type SafeHtml } from './html';

export interface AccountEmailView {
  address: string | null;
  products: boolean;
  boards: boolean;
  referrals: boolean;
  csrf: string;
  /** Show the "saved" confirmation after the POST redirect. */
  saved: boolean;
}

const GROUPS: { name: 'products' | 'boards' | 'referrals'; label: string; hint: string }[] = [
  { name: 'products', label: 'Products', hint: 'Moderation decisions on your products.' },
  { name: 'boards', label: 'Boards', hint: 'Your ranks when the boards lock at 03:12 ICT.' },
  { name: 'referrals', label: 'Referrals', hint: 'Commission that became available in your wallet.' },
];

export function accountEmailSection(v: AccountEmailView): SafeHtml {
  const address = v.address
    ? html`<p>We send email to <strong>${v.address}</strong>, the address of the account you signed in with.</p>`
    : html`<p class="muted">No email address is on file for this account, so we cannot send you email. Sign in with a GitHub or Google account that shares its email to add one.</p>`;
  return html`<section class="acct-sec" id="email" aria-labelledby="email-title">
      <h2 id="email-title">Email</h2>
      ${address}
      ${v.saved ? html`<p role="status"><strong>Email preferences saved.</strong></p>` : ''}
      <form class="pay-form panel-box" method="post" action="/account/email">
        <input type="hidden" name="csrf" value="${v.csrf}">
        <fieldset>
          <legend>Send me email about</legend>
          ${GROUPS.map(g => html`<label class="ack" for="email-${g.name}"><input type="checkbox" id="email-${g.name}" name="${g.name}" value="1"${v[g.name] ? html` checked` : ''}><span><strong>${g.label}</strong>: ${g.hint}</span></label>`)}
        </fieldset>
        <button class="btn btn-primary btn-sm" type="submit">Save email preferences</button>
      </form>
      <p class="muted">Bid receipts, refunds and chargebacks, payouts and the welcome email are always sent.</p>
    </section>`;
}
