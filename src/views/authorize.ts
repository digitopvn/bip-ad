// MCP OAuth consent screen. Every client-supplied string (name, redirect host) is untrusted and escaped.
// Approving is an explicit POST bound to this browser by the provider's consent handle cookie.
import { notice } from './components';
import { authCard, GITHUB_ICON, GOOGLE_ICON } from './login';
import { html } from './html';
import type { LayoutContext } from './types';

const SCOPE_COPY: Record<string, string> = {
  'bip.products': 'Create and edit your products and their pages (published edits are re-moderated)',
  'bip.boosts': 'Quote bids and create checkout links that you approve and pay yourself',
  'bip.wallet': 'Read your referrals and commission wallet, and request payouts',
};

export interface ConsentView {
  clientName: string;
  clientDomain?: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
  scopes: string[];
  handle: string;
}

export function authorizePage(ctx: LayoutContext, v: ConsentView): string {
  const client = v.clientName.trim() || 'An MCP client';
  const scopes = v.scopes.filter((s) => s.trim() !== '');
  const inner = html`<p class="kicker">Connect an agent</p>
<h1 class="auth-title" id="auth-title"><span class="client-name">${client}</span> wants access to your bip.ad account</h1>
<p class="muted">${v.clientDomain ? html`Client domain: <strong>${v.clientDomain}</strong>. ` : html`This client name is self-declared and unverified. `}Tokens will be sent to <strong>${v.redirectHost}</strong>.</p>
${v.redirectIsLoopback ? notice('error', 'This client receives tokens on your own computer (localhost). Any local program could be listening; approve only if you just started this client yourself.', 'alert') : ''}
${scopes.length
  ? html`<ul class="list-check yes scope-list" aria-label="Requested access">${scopes.map(
      (s) => html`<li><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg><span>${SCOPE_COPY[s] ?? s}</span></li>`,
    )}</ul>`
  : ''}
<p class="muted">Your agent can never move money on its own: every payment needs your approval on a checkout page.</p>
<form method="post" action="/authorize" class="auth-buttons">
  <input type="hidden" name="handle" value="${v.handle}">
  <button type="submit" name="provider" value="github" class="btn btn-primary auth-btn">${GITHUB_ICON}Approve and continue with GitHub</button>
  <button type="submit" name="provider" value="google" class="btn btn-ghost auth-btn">${GOOGLE_ICON}Approve and continue with Google</button>
  <button type="submit" name="action" value="deny" class="btn btn-ghost auth-btn">Deny</button>
</form>
<p class="auth-foot">Only approve clients you started yourself.</p>`;
  return authCard(ctx, inner);
}
