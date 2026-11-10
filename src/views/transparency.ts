// Public /transparency page: per-board ads funds and flights with caps, money states, as_of_at and source.
import type { TransparencyFlight, TransparencyView } from '../ads/ads-transparency';
import { notice } from './components';
import { boardLabel, formatIctDateTime, formatMoney } from './format';
import { html, type SafeHtml } from './html';
import { layout } from './layout';
import type { LayoutContext } from './types';

/** Plain-language label of a metrics source code (see METRIC_SOURCE in src/ads/ads-flight-operations.ts). */
function metricsLabel(f: TransparencyFlight): string {
  if (!f.metricsSource) return 'No metrics recorded yet';
  if (f.metricsState === 'no_data') {
    return f.metricsSource === 'dry_run_no_provider' ? 'No data: dry run, no ad provider connected' : 'No data: provider metrics not ingested yet';
  }
  return f.metricsSource;
}

const STATE_LABEL: Record<string, string> = {
  planned: 'Waiting for plan', held: 'Held: no ad channel can take it yet', scheduled: 'Planned', active: 'Running', paused: 'Paused', ended: 'Ended',
};

function flightRow(f: TransparencyFlight, dryRun: boolean): SafeHtml {
  const money = (minor: number) => formatMoney(f.currency, minor);
  const state = `${STATE_LABEL[f.state] ?? f.state}${dryRun || f.adapterStatus !== 'live' ? ' (dry run)' : ''}`;
  return html`<tr><th scope="row">${boardLabel(f.board)}</th><td>${formatIctDateTime(f.startAt)} to ${formatIctDateTime(f.endAt)}</td><td class="num">${money(f.spendCapMinor)}</td><td class="num">${money(
    f.dailyCapMinor,
  )}</td><td class="num">${money(f.plannedMinor)}</td><td class="num">${money(f.committedMinor)}</td><td class="num">${money(f.spentMinor)}</td><td>${state}</td><td>${
    f.metricsAsOfAt ? html`<time datetime="${f.metricsAsOfAt}">${formatIctDateTime(f.metricsAsOfAt)}</time>` : '—'
  }</td><td>${metricsLabel(f)}</td></tr>`;
}

export function transparencyPage(ctx: LayoutContext, view: TransparencyView): string {
  const dryRun = view.adsMode === 'dry_run';
  const banner = dryRun
    ? notice('warn', html`<strong>Dry run.</strong> Ad flights are planned within their caps and every request is recorded, but no campaign runs and no money is spent yet. Spend below stays at zero until the owner approves paid ads.`, null)
    : '';
  const funds = view.funds.length
    ? html`<div class="table-wrap"><table class="data-table"><caption class="sr-only">Ads fund per board</caption><thead><tr><th scope="col">Board</th><th scope="col">Currency</th><th scope="col" class="num">Ads fund (80%)</th><th scope="col" class="num">Spent</th></tr></thead><tbody>${view.funds.map(
        (f) => html`<tr><th scope="row">${boardLabel(f.board)}</th><td>${f.currency}</td><td class="num">${formatMoney(f.currency, f.fundedMinor)}</td><td class="num">${formatMoney(f.currency, f.spentMinor)}</td></tr>`,
      )}</tbody></table></div>`
    : html`<p class="muted">No board has an ads fund yet: no confirmed bid revenue has been locked into a cohort.</p>`;
  const flights = view.flights.length
    ? html`<div class="table-wrap"><table class="data-table"><caption class="sr-only">Ad flights of the last 35 days</caption><thead><tr><th scope="col">Board</th><th scope="col">Window</th><th scope="col" class="num">Spend cap</th><th scope="col" class="num">Daily cap</th><th scope="col" class="num">Planned</th><th scope="col" class="num">Committed</th><th scope="col" class="num">Spent</th><th scope="col">State</th><th scope="col">Metrics as of</th><th scope="col">Metrics source</th></tr></thead><tbody>${view.flights.map(
        (f) => flightRow(f, dryRun),
      )}</tbody></table></div>`
    : html`<p class="muted">No ad flights in the last 35 days.</p>`;

  const body = html`<section class="section-tight transparency" aria-labelledby="transparency-title">
  <div class="wrap">
    <p class="kicker">Transparency${dryRun ? ' · dry run' : ''}</p>
    <h1 class="h2" id="transparency-title">Where the 80% ads fund goes</h1>
    <p class="section-lede">80% of every bid funds ads for its own board only. Each nightly cohort becomes one flight of 1, 7 or 30 days with a hard spend cap and daily cap. Daily money never pays for Weekly or Monthly ads.</p>
    ${banner}
    ${view.killSwitchEngaged ? notice('error', html`<strong>Ads are stopped.</strong> The operator kill switch is on; every flight is paused.`, null) : ''}
    <p class="snap-facts"><span>Figures as of <time datetime="${view.asOfAt}">${formatIctDateTime(view.asOfAt)}</time></span><span>Source: ${view.source}</span><span>Ads mode: ${dryRun ? 'dry run' : 'live'}</span></p>
    <h2 class="snap-h">Ads fund per board</h2>
    ${funds}
    <h2 class="snap-h">Flights</h2>
    ${flights}
    <p class="muted">Unspent money stays with its board and cohort; it is never moved to another board or counted as platform revenue. Metrics are shown only as the provider reports them; without provider data the row says so instead of estimating.</p>
  </div>
</section>`;
  return layout(ctx, body.toString());
}
