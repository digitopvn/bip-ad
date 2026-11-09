// Moderation outcome email: published, rejected, changes_rejected, suspended.
import type { EmailMessageData } from '../email-message-types';
import type { Block, EmailDoc } from './email-layout-and-helpers';
import { oneLine } from './email-layout-and-helpers';

type Data = Extract<EmailMessageData, { kind: 'product_decision' }>;

const FIX_VIA_MCP =
  'To fix it, ask your AI agent to update the listing over MCP (products.update, or pages.set_blocks for page content) and then call products.submit to send it for review again.';

export function productDecisionDoc(d: Data): EmailDoc {
  const name = oneLine(d.productName);
  const reason: Block[] = d.reason.trim() ? [{ t: 'note', text: `Reason: ${d.reason.trim()}` }] : [];
  const view = { label: 'View on bip.ad', url: d.productUrl };
  const hi: Block = { t: 'p', text: `Hi ${d.displayName},` };
  switch (d.outcome) {
    case 'published':
      return {
        subject: `${name} is live on bip.ad`,
        preheader: `${name} passed review and is now public.`,
        heading: `${name} is live`,
        blocks: [hi, { t: 'p', text: `${name} passed review and is now visible on bip.ad. You can bid for a seat on the Daily, Weekly or Monthly board at any time before the 03:12 ICT lock.` }, ...reason],
        cta: view,
      };
    case 'rejected':
      return {
        subject: `${name} was not approved`,
        preheader: `${name} did not pass review.`,
        heading: `${name} was not approved`,
        blocks: [hi, { t: 'p', text: `${name} did not pass review, so it is not public.` }, ...reason, { t: 'p', text: FIX_VIA_MCP }],
        cta: view,
      };
    case 'changes_rejected':
      return {
        subject: `Your changes to ${name} were not approved`,
        preheader: `${name} stays live with its previous content.`,
        heading: `Changes to ${name} were not approved`,
        blocks: [hi, { t: 'p', text: `Your latest edits to ${name} did not pass review. The listing stays live with its previously approved content.` }, ...reason, { t: 'p', text: FIX_VIA_MCP }],
        cta: view,
      };
    case 'suspended':
      return {
        subject: `${name} was unpublished`,
        preheader: `${name} is no longer public on bip.ad.`,
        heading: `${name} was unpublished`,
        blocks: [hi, { t: 'p', text: `${name} was suspended and is no longer visible on bip.ad.` }, ...reason, { t: 'p', text: 'If you believe this is a mistake, reply to this email or fix the listing through your AI agent over MCP and submit it again.' }],
        cta: view,
      };
  }
}
