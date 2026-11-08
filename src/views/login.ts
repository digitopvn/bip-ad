// Sign-in screen (GitHub or Google) and the MCP OAuth consent screen share one auth card style.
import { icon, notice } from './components';
import { html, raw, type SafeHtml } from './html';
import { layout } from './layout';
import type { LayoutContext } from './types';

export const GITHUB_ICON = raw(
  '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.22 1.88.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>',
);
export const GOOGLE_ICON = raw(
  '<svg class="icon" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>',
);

export function providerButtons(urls: { github: string; google: string }): SafeHtml {
  return html`<div class="auth-buttons">
  <a class="btn btn-primary auth-btn" href="${urls.github}">${GITHUB_ICON}Continue with GitHub</a>
  <a class="btn btn-ghost auth-btn" href="${urls.google}">${GOOGLE_ICON}Continue with Google</a>
</div>`;
}

/** Only same-origin, root-relative paths are allowed as a post-login destination. Control
 *  characters, whitespace and backslashes are rejected: browsers strip them ("/\t/evil.com"). */
export function safeNext(next: string | undefined | null): string {
  if (!next || !/^\/(?![/\\])/.test(next) || /[\x00-\x20\x7f\\]/.test(next)) return '/account';
  try {
    return new URL(next, 'https://bip.invalid').origin === 'https://bip.invalid' ? next : '/account';
  } catch {
    return '/account';
  }
}

export function authCard(ctx: LayoutContext, inner: SafeHtml): string {
  const body = html`<section class="section-tight auth" aria-labelledby="auth-title">
  <div class="wrap narrow"><div class="panel-box auth-card">
    <img class="auth-mark" src="/img/bip-mark.webp" alt="" width="78" height="72">
    ${inner}
  </div></div>
</section>`;
  return layout(ctx, body.toString());
}

export function loginPage(ctx: LayoutContext, opts: { next: string; error?: string }): string {
  const next = encodeURIComponent(safeNext(opts.next));
  const inner = html`<h1 class="auth-title" id="auth-title">Sign in to bip.ad</h1>
<p class="muted">Use the same account your AI agent connects with over MCP. We only read your name, email and avatar.</p>
${opts.error ? notice('error', opts.error, 'alert') : ''}
${providerButtons({ github: `/auth/github/start?next=${next}`, google: `/auth/google/start?next=${next}` })}
<p class="auth-foot">New here? Signing in creates your account. Products are listed by your agent, never through a web form. <a href="/#agents">How it works ${icon('arrow')}</a></p>`;
  return authCard(ctx, inner);
}
