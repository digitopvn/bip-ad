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
}

/** Props stored in the MCP access token grant. */
export interface McpProps extends Record<string, unknown> {
  userId: string;
}
