// MCP OAuth consent screen. The client name comes from dynamic client registration: untrusted, escaped.
import { authCard, providerButtons } from './login';
import { html } from './html';
import type { LayoutContext } from './types';

const SCOPE_COPY: Record<string, string> = {
  products: 'Create and edit your product pages',
  quotes: 'Request bid quotes',
  checkouts: 'Create checkout links that you approve and pay yourself',
  referrals: 'Read your referral link and counts',
  wallet: 'Read your commission wallet and request payouts',
};

export function authorizePage(
  ctx: LayoutContext,
  opts: { clientName: string; scopes: string[]; startUrls: { github: string; google: string } },
): string {
  const client = opts.clientName.trim() || 'An MCP client';
  const scopes = opts.scopes.filter((s) => s.trim() !== '');
  const inner = html`<p class="kicker">Connect an agent</p>
<h1 class="auth-title" id="auth-title"><span class="client-name">${client}</span> wants to manage your BIP.AD products, quotes, checkouts, referrals and wallet</h1>
<p class="muted">Sign in to approve. Your agent can never move money on its own: every payment needs your approval on a checkout page.</p>
${scopes.length
  ? html`<ul class="list-check yes scope-list" aria-label="Requested access">${scopes.map(
      (s) => html`<li><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg><span>${SCOPE_COPY[s] ?? s}</span></li>`,
    )}</ul>`
  : ''}
${providerButtons(opts.startUrls)}
<p class="auth-foot">Only approve clients you started yourself. You can revoke access by signing out of the client.</p>`;
  return authCard(ctx, inner);
}
