// Zernio Ads adapter: the requests bip.ad sends (ADS_MODE=live) or records without sending (dry run).
// Shapes from docs.zernio.com: POST /v1/ads/create (standalone ad: accountId, adAccountId, goal,
// budgetAmount in WHOLE currency units, budgetType daily, startDate/endDate, headline, body,
// linkUrl, imageUrl, status) and POST /v1/ads/campaigns/bulk-status ({ status: paused | active, campaigns }).
import { z } from 'zod';
import { currencyDecimals } from '../views/format';
import type { AdapterRequest } from './adapter-call-log';

/** One ad channel the planner may allocate to: a Zernio-connected account and its ad account. */
export interface AdsChannel {
  channel: string;
  accountId: string;
  adAccountId: string;
  /** Smallest daily budget the channel accepts, in minor units (default: one whole currency unit). */
  minDailyMinor?: number;
}

const channelSchema = z.object({
  channel: z.string().regex(/^[a-z0-9_-]{2,32}$/),
  accountId: z.string().min(1).max(64),
  adAccountId: z.string().min(1).max(64),
  minDailyMinor: z.number().int().positive().optional(),
});

/** Channels from ZERNIO_ADS_ACCOUNTS (JSON array). Unset means none; malformed is reported, never guessed. */
export function parseAdsChannels(raw: string | undefined): { channels: AdsChannel[]; error: string | null } {
  const v = (raw ?? '').trim();
  if (!v) return { channels: [], error: null };
  try {
    const parsed = z.array(channelSchema).max(10).safeParse(JSON.parse(v));
    if (!parsed.success) return { channels: [], error: `ZERNIO_ADS_ACCOUNTS is invalid: ${parsed.error.issues[0]?.message ?? 'bad shape'}` };
    const names = new Set(parsed.data.map(c => c.channel));
    if (names.size !== parsed.data.length) return { channels: [], error: 'ZERNIO_ADS_ACCOUNTS lists a channel twice' };
    return { channels: parsed.data, error: null };
  } catch {
    return { channels: [], error: 'ZERNIO_ADS_ACCOUNTS is not valid JSON' };
  }
}

/** Minor units per whole currency unit (USD 100, VND 1). */
export const wholeUnit = (currency: string) => 10 ** currencyDecimals(currency);

export interface CreateAdInput {
  apiBase: string;
  allocationId: string;
  channel: AdsChannel;
  board: string;
  date: string;
  currency: string;
  dailyMinor: number;
  startAt: string;
  endAt: string;
  snapshotUrl: string;
  imageUrl: string;
}

export function buildCreateAdRequest(i: CreateAdInput): AdapterRequest {
  const label = `${i.board[0].toUpperCase()}${i.board.slice(1)}`;
  return {
    method: 'POST',
    url: `${i.apiBase}/ads/create`,
    idempotencyKey: `ads:create:${i.allocationId}`,
    body: {
      accountId: i.channel.accountId,
      adAccountId: i.channel.adAccountId,
      name: `bip.ad ${i.board} ${i.date} ${i.channel.channel}`,
      goal: 'traffic',
      // Zernio takes whole currency units, not cents; the planner only allocates whole units.
      budgetAmount: i.dailyMinor / wholeUnit(i.currency),
      budgetType: 'daily',
      startDate: i.startAt,
      endDate: i.endAt,
      headline: `${label} Top 10 on bip.ad`,
      body: `The ${label} board locked at 03:12 ICT. See who bid their way to the top.`,
      linkUrl: i.snapshotUrl,
      imageUrl: i.imageUrl,
      status: 'ACTIVE',
    },
  };
}

export function buildCampaignStatusRequest(apiBase: string, campaignIds: string[], status: 'paused' | 'active', key: string): AdapterRequest {
  return { method: 'POST', url: `${apiBase}/ads/campaigns/bulk-status`, idempotencyKey: key, body: { status, campaigns: campaignIds } };
}

/** Campaign id from a create answer; the field name is not pinned down in the docs, so known spellings are tried. */
export function parseCreatedCampaignId(response: unknown): string | null {
  const r = response as Record<string, unknown> | null;
  const nested = (k: string) => (r?.[k] && typeof r[k] === 'object' ? (r[k] as Record<string, unknown>) : null);
  for (const v of [r?.campaignId, nested('campaign')?.id, nested('campaign')?._id, nested('ad')?.campaignId, r?.id]) if (typeof v === 'string' && v) return v;
  return null;
}
