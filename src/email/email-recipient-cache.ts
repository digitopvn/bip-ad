// Recipients of a projection page: users with their email preferences, loaded with one IN query
// per chunk of ids and cached for the page. Each chunk is checked against the run's query budget,
// so a lock with a huge owner set stops the page instead of overrunning the cap.
import { type QueryBudget, QueryBudgetExhausted } from './d1-query-meter';
import type { EmailGroup } from './email-message-types';

/** D1 allows 100 bound parameters per query. */
export const IN_CHUNK = 90;
/** One chunk query plus the page's final batch, which must still fit after the chunk. */
const CHUNK_QUERY_RESERVE = 2;

export interface Recipient {
  displayName: string;
  email: string | null;
  /** null when the user has no preferences row yet (every group on). */
  groups: Record<EmailGroup, boolean> | null;
}

interface RecipientRow {
  id: string;
  display_name: string;
  email: string | null;
  products: number | null;
  boards: number | null;
  referrals: number | null;
}

/** `db` should be metered with `budget`; load() throws QueryBudgetExhausted before a chunk that does not fit. */
export function recipientCache(db: D1Database, budget: QueryBudget) {
  const cache = new Map<string, Recipient | null>();
  async function load(ids: string[]) {
    const missing = [...new Set(ids)].filter(id => !cache.has(id));
    for (let i = 0; i < missing.length; i += IN_CHUNK) {
      if (!budget.allows(CHUNK_QUERY_RESERVE)) throw new QueryBudgetExhausted();
      const chunk = missing.slice(i, i + IN_CHUNK);
      const { results } = await db.prepare(`SELECT u.id, u.display_name, u.email, p.products, p.boards, p.referrals
          FROM users u LEFT JOIN email_preferences p ON p.user_id = u.id WHERE u.id IN (${chunk.map(() => '?').join(', ')})`).bind(...chunk)
        .all<RecipientRow>();
      for (const id of chunk) cache.set(id, null);
      for (const r of results) {
        cache.set(r.id, {
          displayName: r.display_name,
          email: r.email?.trim() || null,
          groups: r.products === null ? null : { products: r.products === 1, boards: r.boards === 1, referrals: r.referrals === 1 },
        });
      }
    }
  }
  return { load, get: (id: string) => cache.get(id) ?? null };
}
