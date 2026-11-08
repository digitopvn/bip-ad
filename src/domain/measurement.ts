// Deduplicated, bot-filtered measurement. One row per (product, event, visitor, ICT day); owners'
// own traffic is excluded. These rows feed the click/view tie-breakers (rolling 30 days).
import { sha256Hex } from '../lib/crypto';
import { ictDate, iso } from '../lib/time';

export type MeasureType = 'product_card_impression' | 'product_card_click' | 'product_page_view' | 'outbound_click';

const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|curl|wget|python|httpclient|axios|node-fetch|go-http/i;

export const isLikelyBot = (ua: string | null | undefined) => !ua || ua.length < 20 || BOT_UA.test(ua);

export async function visitorHash(secret: string, ip: string, ua: string, nowMs: number) {
  // Daily salt: visitors cannot be linked across days from the stored hash.
  return (await sha256Hex(`${secret}|${ictDate(nowMs)}|${ip}|${ua}`)).slice(0, 32);
}

export async function recordEvent(db: D1Database, e: { productId: string; type: MeasureType; visitor: string; source: string; nowMs?: number }) {
  const now = e.nowMs ?? Date.now();
  await db.prepare(`INSERT INTO measurement_events (product_id, event_type, visitor_hash, day, occurred_at, source) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT (product_id, event_type, visitor_hash, day) DO NOTHING`)
    .bind(e.productId, e.type, e.visitor, ictDate(now), iso(now), e.source).run();
}
