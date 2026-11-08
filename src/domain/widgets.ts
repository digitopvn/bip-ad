// Page-builder widget schema v1. Agents send blocks as JSON; the server validates every field.
// No raw HTML, scripts, iframes or non-http(s) URLs are accepted.
import { z } from 'zod';

export const PAGE_SCHEMA_VERSION = 'widgets-v1';

const BLOCKED_HOSTS = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?|metadata\.google\.internal)/i;

export const safeUrl = z.string().max(2048).refine(v => {
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !BLOCKED_HOSTS.test(u.hostname) && !/^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname);
  } catch {
    return false;
  }
}, 'Must be a public http(s) URL');

const text = (max: number) => z.string().trim().min(1).max(max).refine(v => !/<\s*\/?\s*(script|iframe|style|object|embed)/i.test(v), 'HTML is not allowed');
const optText = (max: number) => text(max).optional();

export const widgetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hero'), headline: text(120), subheadline: optText(280), image_url: safeUrl.optional() }).strict(),
  z.object({ type: z.literal('gallery'), images: z.array(z.object({ url: safeUrl, alt: text(160) }).strict()).min(1).max(12) }).strict(),
  z.object({ type: z.literal('video'), url: safeUrl, title: optText(120) }).strict(),
  z.object({ type: z.literal('feature_grid'), title: optText(120), features: z.array(z.object({ title: text(80), body: text(400) }).strict()).min(1).max(12) }).strict(),
  z.object({ type: z.literal('rich_text'), markdown: text(8000) }).strict(),
  z.object({ type: z.literal('call_to_action'), label: text(40), url: safeUrl, note: optText(160) }).strict(),
  z.object({ type: z.literal('pricing'), title: optText(120), plans: z.array(z.object({ name: text(60), price: text(40), features: z.array(text(120)).max(12) }).strict()).min(1).max(6) }).strict(),
  z.object({ type: z.literal('testimonials'), items: z.array(z.object({ quote: text(400), author: text(80) }).strict()).min(1).max(12) }).strict(),
  z.object({ type: z.literal('faq'), items: z.array(z.object({ q: text(200), a: text(1200) }).strict()).min(1).max(20) }).strict(),
  z.object({ type: z.literal('founder_note'), body: text(1500), author: text(80) }).strict(),
  z.object({ type: z.literal('links'), items: z.array(z.object({ label: text(60), url: safeUrl }).strict()).min(1).max(12) }).strict(),
  z.object({ type: z.literal('metrics'), items: z.array(z.object({ label: text(60), value: text(40) }).strict()).min(1).max(8) }).strict(),
]);

export const blocksSchema = z.array(widgetSchema).min(1).max(30);
export type Widget = z.infer<typeof widgetSchema>;

export const WIDGET_TYPES = ['hero', 'gallery', 'video', 'feature_grid', 'rich_text', 'call_to_action', 'pricing', 'testimonials', 'faq', 'founder_note', 'links', 'metrics'] as const;

export function validateBlocks(input: unknown): { ok: true; blocks: Widget[] } | { ok: false; issues: { path: string; message: string }[] } {
  const r = blocksSchema.safeParse(input);
  if (r.success) return { ok: true, blocks: r.data };
  return { ok: false, issues: r.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) };
}
