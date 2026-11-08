// Branded error page for 403, 404, 500 and any other status.
import { icon } from './components';
import { html } from './html';
import { layout } from './layout';
import type { LayoutContext } from './types';

const TITLES: Record<number, string> = {
  400: 'That request did not look right.',
  401: 'Please sign in first.',
  403: 'This page is not yours to see.',
  404: 'Nothing is listed here.',
  409: 'That already happened.',
  429: 'Too many requests. Breathe, then try again.',
  500: 'Something broke on our side.',
};

export function errorPage(ctx: LayoutContext, status: number, message: string): string {
  const code = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  const title = TITLES[code] ?? (code >= 500 ? TITLES[500] : 'Something went wrong.');
  const body = html`<section class="section-tight error-page" aria-labelledby="err-title">
  <div class="wrap narrow">
    <p class="err-code" aria-hidden="true">${code}</p>
    <h1 class="h2" id="err-title"><span class="sr-only">Error ${code}: </span>${title}</h1>
    ${message ? html`<p class="section-lede">${message}</p>` : ''}
    <div class="cta-row"><a class="btn btn-primary" href="/">Back to the board ${icon('arrow')}</a>${
      code === 401 || code === 403 ? html`<a class="btn btn-ghost" href="/login?next=${encodeURIComponent(ctx.path)}">Sign in</a>` : ''
    }</div>
  </div>
</section>`;
  return layout(ctx, body.toString());
}
