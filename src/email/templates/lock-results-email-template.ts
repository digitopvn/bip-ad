// Nightly lock results: where each of the owner's products landed.
import type { EmailMessageData } from '../email-message-types';
import { boardLabel, formatIctDateTime, formatRankUnits } from '../../views/format';
import type { EmailDoc } from './email-layout-and-helpers';
import { oneLine } from './email-layout-and-helpers';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 9" for an instant, in ICT. */
function ictDay(iso: string): string {
  const t = new Date(new Date(iso).getTime() + 7 * 3600 * 1000);
  return Number.isNaN(t.getTime()) ? iso : `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}`;
}

export function lockResultsDoc(d: Extract<EmailMessageData, { kind: 'lock_results' }>): EmailDoc {
  const day = ictDay(d.cutoffAt);
  const best = [...d.entries].sort((a, b) => a.rank - b.rank)[0];
  const subject = best
    ? `Lock results for ${day}: ${oneLine(best.productName)} is #${best.rank} on ${boardLabel(best.board)}${d.entries.length > 1 ? ` (+${d.entries.length - 1} more)` : ''}`
    : `Lock results for ${day}`;
  return {
    subject,
    preheader: `The ${formatIctDateTime(d.cutoffAt)} lock is final.`,
    heading: `Lock results for ${day}`,
    blocks: [
      { t: 'p', text: `Hi ${d.displayName}, the boards locked at ${formatIctDateTime(d.cutoffAt)}. Here is where your products placed.` },
      {
        t: 'table',
        head: ['Product', 'Board', 'Rank', 'Weight'],
        rows: d.entries.map((e) => [{ text: oneLine(e.productName), url: e.productUrl }, boardLabel(e.board), `#${e.rank} of ${e.boardSize}`, formatRankUnits(e.rankUnits)]),
      },
      { t: 'p', text: `The next lock is ${formatIctDateTime(d.nextCutoffAt)}. Bids confirmed before then count toward it.` },
    ],
    cta: { label: 'See the boards', url: d.boardsUrl },
  };
}
