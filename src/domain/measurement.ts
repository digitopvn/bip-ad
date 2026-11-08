// Deduplicated, bot-filtered measurement. One row per (product, event, visitor, ICT day); owners'
// own traffic is excluded. These rows feed the click/view tie-breakers (rolling 30 days).
import { sha256Hex } from '../lib/crypto';
import { ictDate, iso } from '../lib/time';

export type MeasureType = 'product_card_impression' | 'product_card_click' | 'product_page_view' | 'outbound_click';

const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|curl|wget|python|httpclient|axios|node-fetch|go-http/i;

export const isLikelyBot = (ua: string | null | undefined) => !ua || ua.length < 20 || BOT_UA.test(ua);

/**
 * One visitor per network address per ICT day. The User-Agent is deliberately not part of the key:
 * rotating it from one address must not mint new "unique" visitors (tie-breakers are rankable).
 * Daily salt: visitors cannot be linked across days from the stored hash.
 */
export async function visitorHash(secret: string, ip: string, nowMs: number) {
  return (await sha256Hex(`${secret}|${ictDate(nowMs)}|${networkKey(ip)}`)).slice(0, 32);
}

/** IPv4: the address. IPv6: its /64, the unit one subscriber usually controls. */
export function networkKey(ip: string) {
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${full.slice(0, 4).map(x => x.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export async function recordEvent(db: D1Database, e: { productId: string; type: MeasureType; visitor: string; source: string; nowMs?: number }) {
  const now = e.nowMs ?? Date.now();
  await db.prepare(`INSERT INTO measurement_events (product_id, event_type, visitor_hash, day, occurred_at, source) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT (product_id, event_type, visitor_hash, day) DO NOTHING`)
    .bind(e.productId, e.type, e.visitor, ictDate(now), iso(now), e.source).run();
}
