import type { Env } from '../env';
import { DAY_MS } from '../lib/time';

export type Board = 'daily' | 'weekly' | 'monthly';
export const BOARDS: Board[] = ['daily', 'weekly', 'monthly'];
export const isBoard = (s: string): s is Board => (BOARDS as string[]).includes(s);

/** Contribution lifetime and ad-flight length per board (ADR-0002: rolling from confirmed_at). */
export const BOARD_DURATION_MS: Record<Board, number> = { daily: DAY_MS, weekly: 7 * DAY_MS, monthly: 30 * DAY_MS };
export const BOARD_HOURS: Record<Board, number> = { daily: 24, weekly: 168, monthly: 720 };
export const BOARD_DAYS: Record<Board, number> = { daily: 1, weekly: 7, monthly: 30 };

export const RANKING_POLICY_VERSION = 'rank-v1';
export const METRIC_WINDOW_MS = 30 * DAY_MS;
export const REFERRAL_POLICY_VERSION = 'ref-v1-first-cash-bid';
export const MODERATION_POLICY_VERSION = 'mod-v1';
export const ADS_SHARE_BPS = 8000; // 80%
export const COMMISSION_SHARE_BPS = 500; // 5%
export const TOP_N = 10;
/** Largest single bid accepted while PAYMENT_MODE=simulated (USD 1,000), so test bids stay plausible. */
export const SIMULATED_MAX_RANK_UNITS = 100_000;

export type ModerationMode = 'screen' | 'manual' | 'ai';

export type PaymentMode = 'simulated' | 'sandbox' | 'live';
export type Currency = 'USD' | 'VND';

export interface Config {
  paymentMode: PaymentMode;
  minBidUnits: number;
  minIncrementUnits: number;
  fxUsdVnd: number;
  quoteTtlMs: number;
  referralHoldMs: number;
  referralAttributionMs: number;
  minPayout: Record<Currency, number>;
  moderationMode: ModerationMode;
  /** True only in the screen mode: the regex screen alone publishes inline. Other modes defer to the AI job or the operator. */
  autoApprove: boolean;
  origin: string;
}

const int = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
};

export function config(env: Env): Config {
  // Live mode needs both PAYMENT_MODE=live and the explicit LIVE_PAYMENTS flag; otherwise it degrades to sandbox.
  // Fail closed: an unset mode is simulated, but a typo (e.g. "Live") is a configuration error.
  const raw = (env.PAYMENT_MODE ?? '').trim();
  if (raw && raw !== 'simulated' && raw !== 'sandbox' && raw !== 'live') throw new Error(`Invalid PAYMENT_MODE "${raw}": use simulated, sandbox or live`);
  // Fail closed: an unset moderation mode means the operator approves everything.
  const rawModeration = (env.MODERATION_MODE ?? '').trim();
  if (rawModeration && rawModeration !== 'screen' && rawModeration !== 'manual' && rawModeration !== 'ai') throw new Error(`Invalid MODERATION_MODE "${rawModeration}": use screen, manual or ai`);
  const moderationMode: ModerationMode = (rawModeration || 'manual') as ModerationMode;
  let mode: PaymentMode = raw === 'live' || raw === 'sandbox' ? raw : 'simulated';
  if (mode === 'live' && env.LIVE_PAYMENTS !== 'true') mode = 'sandbox';
  return {
    paymentMode: mode,
    minBidUnits: int(env.MIN_BID_UNITS, 100),
    minIncrementUnits: int(env.MIN_BID_INCREMENT_UNITS, 100),
    fxUsdVnd: int(env.FX_USD_VND, 25400),
    quoteTtlMs: int(env.QUOTE_TTL_SECONDS, 900) * 1000,
    referralHoldMs: int(env.REFERRAL_HOLD_DAYS, 30) * DAY_MS,
    referralAttributionMs: int(env.REFERRAL_ATTRIBUTION_DAYS, 30) * DAY_MS,
    minPayout: { USD: int(env.MIN_PAYOUT_USD_CENTS, 1000), VND: int(env.MIN_PAYOUT_VND, 250000) },
    moderationMode,
    autoApprove: moderationMode === 'screen',
    origin: (env.PUBLIC_ORIGIN || 'http://localhost:8787').replace(/\/$/, ''),
  };
}
