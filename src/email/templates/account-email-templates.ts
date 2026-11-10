// Welcome, referral commission and payout emails.
import type { EmailMessageData, EmailRenderContext } from '../email-message-types';
import { formatMoney } from '../../views/format';
import type { EmailDoc } from './email-layout-and-helpers';
import { oneLine } from './email-layout-and-helpers';

export function welcomeDoc(d: Extract<EmailMessageData, { kind: 'welcome' }>, ctx: EmailRenderContext): EmailDoc {
  const origin = ctx.origin.replace(/\/+$/, '');
  return {
    subject: 'Welcome to bip.ad: build in public, bid to win',
    preheader: 'How bip.ad works, and how to list your first product with your AI agent.',
    heading: `Welcome to bip.ad, ${d.displayName}`,
    blocks: [
      { t: 'p', text: 'bip.ad is an open launch board for builders. Your AI agent lists your product over MCP, then you bid openly for a seat on three boards: Daily, Weekly and Monthly. Every bid is public, and the highest total bid ranks first.' },
      { t: 'p', text: 'All three boards lock at 03:12 ICT every night. Read upside down, "3:12" looks like BIP.' },
      { t: 'h2', text: 'How it works' },
      {
        t: 'steps',
        items: [
          ['Connect your AI agent', 'Add the MCP server below to Claude, ChatGPT or any MCP client, and sign in with the same GitHub or Google account you used here.'],
          ['List your product', 'Ask your agent to create the product, build its page from widgets (hero, gallery, pricing, FAQ and more) and submit it. Every submission is reviewed; low-risk ones publish automatically.'],
          ['Bid for a seat', 'Your agent quotes a bid and gives you a checkout link to pay. Ties are broken by successful referrals, then valid unique clicks, then valid unique views.'],
          ['Lock at 03:12 ICT', 'Standings freeze every night. We email you where your products landed on each board.'],
          ['Share your referral link', 'Earn 5% commission on the first bid each builder you refer pays with PayPal or SePay. Spend it on bids, or request a payout on days 01 to 10 of each month.'],
        ],
      },
      { t: 'p', text: 'Your MCP server URL:' },
      { t: 'code', text: `${origin}/mcp` },
      { t: 'note', text: 'The auction is all-pay: every confirmed bid is collected, with no refund when you are outbid and no guaranteed results. 80% of each board\'s bid revenue funds that board\'s ads.' },
    ],
    cta: { label: 'See the live boards', url: origin },
  };
}

export function commissionAvailableDoc(d: Extract<EmailMessageData, { kind: 'commission_available' }>): EmailDoc {
  const amount = formatMoney(d.amount.currency, d.amount.minor);
  return {
    subject: `You earned ${amount} in referral commission`,
    preheader: `${amount} is now available in your wallet.`,
    heading: `${amount} commission is available`,
    blocks: [{ t: 'p', text: `Hi ${d.displayName}, ${amount} in referral commission has cleared and is now available in your bip.ad wallet.` }],
    cta: { label: 'Open your wallet', url: d.walletUrl },
  };
}

export function payoutPaidDoc(d: Extract<EmailMessageData, { kind: 'payout_paid' }>): EmailDoc {
  const amount = formatMoney(d.amount.currency, d.amount.minor);
  return {
    subject: `Your ${amount} payout has been sent`,
    preheader: `${amount} was paid out via ${oneLine(d.method)}.`,
    heading: 'Your payout has been sent',
    blocks: [
      { t: 'p', text: `Hi ${d.displayName}, we sent your payout.` },
      { t: 'facts', rows: [['Amount', amount], ['Method', oneLine(d.method)], ['Reference', oneLine(d.reference)]] },
    ],
    cta: { label: 'Open your wallet', url: d.walletUrl },
  };
}
