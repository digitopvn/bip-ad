// Asia/Ho_Chi_Minh is a fixed UTC+7 offset with no daylight saving.
export const ICT_OFFSET_MS = 7 * 3600_000;
export const HOUR_MS = 3600_000;
export const DAY_MS = 24 * HOUR_MS;
const CUTOFF_H = 3;
const CUTOFF_M = 12;

export const iso = (ms: number) => new Date(ms).toISOString();

/** The 03:12 ICT cutoff on the given ICT calendar date (yyyy-mm-dd), as epoch ms. */
export function cutoffForIctDate(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, CUTOFF_H, CUTOFF_M) - ICT_OFFSET_MS;
}

/** ICT calendar date (yyyy-mm-dd) of an instant. */
export function ictDate(ms: number): string {
  return new Date(ms + ICT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Latest cutoff at or before `ms`. */
export function cutoffAtOrBefore(ms: number): number {
  const c = cutoffForIctDate(ictDate(ms));
  return c <= ms ? c : c - DAY_MS;
}

/** First cutoff strictly after `ms`: a payment confirmed exactly at 03:12:00 belongs to the next cohort. */
export function nextCutoffAfter(ms: number): number {
  return cutoffAtOrBefore(ms) + DAY_MS;
}

export const isValidDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
