// Welcome, referral commission and payout emails.
import type { EmailMessageData, EmailRenderContext } from '../email-message-types';
import { formatMoney } from '../../views/format';
import type { EmailDoc } from './email-layout-and-helpers';
import { oneLine } from './email-layout-and-helpers';

export function welcomeDoc(d: Extract<EmailMessageData, { kind: 'welcome' }>, ctx: EmailRenderContext): EmailDoc {
  const origin = ctx.origin.replace(/\/+$/, '');
  return {
    subject: 'Welcome to bip.ad',
    preheader: 'Connect your AI agent and list your first product.',
    heading: 'Welcome to bip.ad',
    blocks: [
      { t: 'p', text: `Hi ${d.displayName}, bip.ad is an open launch board: your AI agent lists your product over MCP, and you bid openly for a seat on the boards.` },
      { t: 'p', text: 'To get started, add this MCP server URL to your AI agent:' },
      { t: 'code', text: `${origin}/mcp` },
      { t: 'p', text: 'There are three boards: Daily (24 hours), Weekly (7 days) and Monthly (30 days). All three lock at 03:12 ICT every night. The auction is all-pay: confirmed bids are not refunded when you are outbid.' },
    ],
    cta: { label: 'Open bip.ad', url: origin },
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
