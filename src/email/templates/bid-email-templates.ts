// Bid receipt and bid reversal emails (both mandatory: no unsubscribe).
import type { EmailMessageData } from '../email-message-types';
import { boardLabel, formatIctDateTime, formatMoney, formatRankUnits } from '../../views/format';
import type { EmailDoc } from './email-layout-and-helpers';
import { oneLine } from './email-layout-and-helpers';

const PROVIDER = { paypal: 'PayPal', sepay: 'SePay bank transfer', wallet: 'bip.ad wallet' } as const;

export function bidReceiptDoc(d: Extract<EmailMessageData, { kind: 'bid_receipt' }>): EmailDoc {
  const name = oneLine(d.productName);
  const board = boardLabel(d.board);
  const weight = formatRankUnits(d.rankUnits);
  return {
    subject: `Your bid on ${name} is confirmed: ${weight} on ${board}`,
    preheader: `Receipt: ${weight} ranking weight on the ${board} board.`,
    heading: 'Your bid is confirmed',
    blocks: [
      { t: 'p', text: `Hi ${d.displayName}, your bid for ${name} on the ${board} board is confirmed.` },
      ...(d.test ? [{ t: 'note' as const, text: 'Test payment — no money moved.' }] : []),
      {
        t: 'facts',
        rows: [
          ['Product', { text: name, url: d.productUrl }],
          ['Board', board],
          ['Ranking weight', weight],
          ['Cash paid', formatMoney(d.cash.currency, d.cash.minor)],
          ['Wallet applied', formatMoney(d.wallet.currency, d.wallet.minor)],
          ['Provider', PROVIDER[d.provider]],
          ['Bid ID', d.bidIntentId],
          ['Confirmed', formatIctDateTime(d.confirmedAt)],
        ],
      },
      { t: 'note', text: 'bip.ad is all-pay: confirmed bids are not refunded when you are outbid. Your ranking weight counts toward the next 03:12 ICT lock.' },
    ],
    cta: { label: 'View your product', url: d.productUrl },
  };
}

export function bidReversedDoc(d: Extract<EmailMessageData, { kind: 'bid_reversed' }>): EmailDoc {
  const name = oneLine(d.productName);
  const board = boardLabel(d.board);
  const amount = formatMoney(d.amount.currency, d.amount.minor);
  const what = d.reversal === 'refund' ? 'refunded' : 'reversed by a chargeback';
  return {
    subject: `Your ${board} bid on ${name} was ${what}: ${amount}`,
    preheader: `${amount} was ${what}; the bid no longer counts.`,
    heading: `Your bid was ${what}`,
    blocks: [
      { t: 'p', text: `Hi ${d.displayName}, a payment of ${amount} for your bid on ${name} (${board} board) was ${what}.` },
      { t: 'p', text: 'This bid no longer counts toward your ranking, and the ranking weight it provided has been removed.' },
      { t: 'facts', rows: [['Product', { text: name, url: d.productUrl }], ['Board', board], ['Amount', amount], ['Type', d.reversal === 'refund' ? 'Refund' : 'Chargeback'], ['Bid ID', d.bidIntentId]] },
    ],
    cta: { label: 'View your product', url: d.productUrl },
  };
}
