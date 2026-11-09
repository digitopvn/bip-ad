// Shared contract between the email projector (which reads domain events and builds the data
// below) and the templates (which turn that data into a subject, HTML and plain text).
// Money fields carry minor units plus a currency; templates format them for display.

/** Preference groups a user can switch off. Mandatory emails (receipts, refunds, payouts, welcome) have no group. */
export type EmailGroup = 'products' | 'boards' | 'referrals';

export const EMAIL_GROUPS: readonly EmailGroup[] = ['products', 'boards', 'referrals'];

export type BoardCode = 'daily' | 'weekly' | 'monthly';

export interface Money {
  currency: string;
  minor: number;
}

/** Every email kind with the data its template needs. The `kind` string is stored in email_outbox.kind. */
export type EmailMessageData =
  | { kind: 'welcome'; displayName: string }
  | {
      kind: 'product_decision';
      displayName: string;
      productName: string;
      productUrl: string;
      /** published: approved (new or edits); rejected: the product, or only its pending changes when it stays live; suspended: unpublished. */
      outcome: 'published' | 'rejected' | 'changes_rejected' | 'suspended';
      /** Operator or policy reason; empty when none was given. */
      reason: string;
    }
  | {
      kind: 'bid_receipt';
      displayName: string;
      productName: string;
      productUrl: string;
      board: BoardCode;
      /** Ranking weight in USD cents. */
      rankUnits: number;
      cash: Money;
      wallet: Money;
      provider: 'paypal' | 'sepay' | 'wallet';
      /** Simulated or sandbox payment: no money moved. */
      test: boolean;
      bidIntentId: string;
      confirmedAt: string;
    }
  | {
      kind: 'bid_reversed';
      displayName: string;
      productName: string;
      productUrl: string;
      board: BoardCode;
      reversal: 'refund' | 'chargeback';
      amount: Money;
      bidIntentId: string;
    }
  | {
      kind: 'lock_results';
      displayName: string;
      /** ISO instant of the 03:12 ICT cutoff that locked. */
      cutoffAt: string;
      nextCutoffAt: string;
      entries: { productName: string; productUrl: string; board: BoardCode; rank: number; boardSize: number; rankUnits: number }[];
      boardsUrl: string;
    }
  | { kind: 'commission_available'; displayName: string; amount: Money; walletUrl: string }
  | { kind: 'payout_paid'; displayName: string; amount: Money; method: string; reference: string; walletUrl: string };

export type EmailKind = EmailMessageData['kind'];

/** Group of each kind; null means mandatory (always sent while the user has an email). */
export const EMAIL_KIND_GROUP: Record<EmailKind, EmailGroup | null> = {
  welcome: null,
  product_decision: 'products',
  bid_receipt: null,
  bid_reversed: null,
  lock_results: 'boards',
  commission_available: 'referrals',
  payout_paid: null,
};

/** Context every template receives besides its data. */
export interface EmailRenderContext {
  /** e.g. https://bip.ad */
  origin: string;
  /** One-click unsubscribe URL for this email's group; null for mandatory emails. */
  unsubscribeUrl: string | null;
  /** Link to /account where groups are switched on and off. */
  preferencesUrl: string;
  /** "[staging] " on staging, "" on production. Templates prepend it to the subject. */
  subjectPrefix: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}
