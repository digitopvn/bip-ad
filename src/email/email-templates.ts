// Entry point for transactional emails: picks the per-kind document and renders it.
import type { EmailMessageData, EmailRenderContext, RenderedEmail } from './email-message-types';
import { commissionAvailableDoc, payoutPaidDoc, welcomeDoc } from './templates/account-email-templates';
import { bidReceiptDoc, bidReversedDoc } from './templates/bid-email-templates';
import { type EmailDoc, renderDoc } from './templates/email-layout-and-helpers';
import { lockResultsDoc } from './templates/lock-results-email-template';
import { productDecisionDoc } from './templates/product-decision-email-template';

function documentFor(data: EmailMessageData, ctx: EmailRenderContext): EmailDoc {
  switch (data.kind) {
    case 'welcome':
      return welcomeDoc(data, ctx);
    case 'product_decision':
      return productDecisionDoc(data);
    case 'bid_receipt':
      return bidReceiptDoc(data);
    case 'bid_reversed':
      return bidReversedDoc(data);
    case 'lock_results':
      return lockResultsDoc(data);
    case 'commission_available':
      return commissionAvailableDoc(data);
    case 'payout_paid':
      return payoutPaidDoc(data);
  }
}

/** Render one transactional email. Pure: no I/O, deterministic for the same input. */
export function renderEmail(data: EmailMessageData, ctx: EmailRenderContext): RenderedEmail {
  return renderDoc(documentFor(data, ctx), ctx);
}
