import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  ASSETS: Fetcher;
  OAUTH_PROVIDER: OAuthHelpers;

  PUBLIC_ORIGIN: string;
  /** simulated: no provider calls, test checkout buttons. sandbox/live: real provider APIs. */
  PAYMENT_MODE: 'simulated' | 'sandbox' | 'live';
  /** Must be exactly "true" before PAYMENT_MODE=live is honoured. */
  LIVE_PAYMENTS: string;
  MIN_BID_UNITS: string;
  MIN_BID_INCREMENT_UNITS: string;
  FX_USD_VND: string;
  QUOTE_TTL_SECONDS: string;
  REFERRAL_HOLD_DAYS: string;
  REFERRAL_ATTRIBUTION_DAYS: string;
  MIN_PAYOUT_USD_CENTS: string;
  MIN_PAYOUT_VND: string;
  /** screen: regex screen auto-approves inline (local dev/tests). manual: AI scores, operator approves. ai: AI auto-approves low-risk changes. */
  MODERATION_MODE?: string;
  /** Decision (System One) model provider: cloudflare (Clef on Workers AI), typesafe (Jev) or openrouter (Jev). */
  MODERATION_DECISION_PROVIDER?: string;
  /** Fast decision model for the inline stage, e.g. clef or clef-omni. */
  MODERATION_DECISION_MODEL_FAST?: string;
  /** Decision model for the full (async) stage, e.g. clef. */
  MODERATION_DECISION_MODEL?: string;
  /** OpenAI-compatible chat provider for the evidence LLM: cloudflare (Workers AI) or openrouter. */
  MODERATION_LLM_PROVIDER?: string;
  MODERATION_LLM_MODEL?: string;
  /** Highest combined risk (0-1) that the ai mode still auto-approves. */
  MODERATION_APPROVE_MAX_RISK?: string;
  PAYPAL_API_BASE: string;
  SEPAY_API_BASE: string;
  SEPAY_CHECKOUT_URL: string;

  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  /** Encrypts payout beneficiary details at rest. Payout requests are refused while it is unset. */
  PII_ENCRYPTION_KEY?: string;
  /** The replaced PII_ENCRYPTION_KEY during a rotation; decrypt-only. */
  PII_ENCRYPTION_KEY_PREVIOUS?: string;
  OPERATOR_TOKEN: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_WEBHOOK_ID?: string;
  SEPAY_MERCHANT_ID?: string;
  SEPAY_SECRET_KEY?: string;
  SEPAY_IPN_SECRET?: string;
  /** Workers AI is called over REST with its own account, separate from the account that hosts this worker. */
  AI_CLOUDFLARE_ACCOUNT_ID?: string;
  AI_CLOUDFLARE_API_TOKEN?: string;
  TYPESAFE_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  /** Cloudflare Email Service binding for transactional email. Without it emails stay queued. */
  EMAIL?: SendEmail;
  /** Sender, "Name <address>" or a bare address, e.g. "bip.ad <hello@bip.ad>". */
  EMAIL_FROM?: string;
  /** Optional Reply-To address for transactional email. */
  EMAIL_REPLY_TO?: string;
  /** Recipient of operator alert emails (reconcile unbalanced, email backlog, missed lock, dead letters). */
  OPERATOR_ALERT_EMAIL?: string;

  /** dry_run (default): ad requests are recorded, never sent. live: sent to Zernio Ads, only with ADS_LIVE_APPROVED=true. */
  ADS_MODE?: string;
  /** Must be exactly "true" before ADS_MODE=live is honoured (owner approval of paid campaigns). */
  ADS_LIVE_APPROVED?: string;
  /** "true" stops all ad planning and execution and pauses running flights, whatever the operator switch says. */
  ADS_KILL_SWITCH?: string;
  /** JSON array of ad channels: [{"channel":"meta","accountId":"...","adAccountId":"act_...","minDailyMinor":100}]. */
  ZERNIO_ADS_ACCOUNTS?: string;
  /** mock (default): publications are recorded as mocked, nothing is posted. live: posts through Zernio. */
  SOCIAL_MODE?: string;
  /** Zernio API key (secret, "sk_..."). Needed by SOCIAL_MODE=live and ADS_MODE=live. */
  ZERNIO_API_KEY?: string;
  /** Zernio REST base, default https://zernio.com/api/v1. */
  ZERNIO_API_BASE?: string;
  /** Zernio account ids (the account `_id` from GET /v1/accounts) of each connected social account. */
  ZERNIO_ACCOUNT_X?: string;
  ZERNIO_ACCOUNT_FACEBOOK?: string;
  ZERNIO_ACCOUNT_YOUTUBE?: string;
  ZERNIO_ACCOUNT_TIKTOK?: string;
}

/** Props stored in the MCP access token grant. */
export interface McpProps extends Record<string, unknown> {
  userId: string;
}
