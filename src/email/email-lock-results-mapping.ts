// Lock results: ONE email per product owner per 03:12 cutoff, summarising every board frozen at
// that cutoff. Each of the three BoardSnapshotFrozen events of a lock maps to the same dedupe key
// (lock:<cutoffAt>:<userId>), so whichever event is projected first builds the email from ALL
// snapshots of the cutoff and the others are no-ops.
import { BOARDS, type Board } from '../domain/config';
import { CATCH_UP_DAYS } from '../domain/snapshot';
import { DAY_MS, iso } from '../lib/time';
import type { EmailMessageData } from './email-message-types';
import { type EmailDraft, type MappingContext, type MappingResult, type OutboxEvent, type Payload, productUrl } from './email-projection-types';

type LockEntry = Extract<EmailMessageData, { kind: 'lock_results' }>['entries'][number];

interface LockItemRow {
  board: Board;
  rank: number;
  rank_units: number;
  owner_id: string;
  name: string;
  slug: string;
  board_size: number;
}

async function cutoffOf(ctx: MappingContext, e: OutboxEvent, p: Payload): Promise<string | null> {
  if (typeof p.cutoffAt === 'string' && !Number.isNaN(Date.parse(p.cutoffAt))) return p.cutoffAt;
  const s = await ctx.db.prepare('SELECT cutoff_at FROM board_snapshots WHERE id = ?').bind(e.aggregate_id).first<{ cutoff_at: string }>();
  return s?.cutoff_at ?? null;
}

/**
 * A lock run freezes daily, weekly and monthly one after another. Until all three snapshots of
 * the cutoff exist the event is deferred, so the email never misses a board that is about to
 * freeze. Edge case: when a lock run fails part-way, the hourly catch-up retries it for
 * CATCH_UP_DAYS; once the cutoff is older than that it can no longer be locked, and the email is
 * built from the snapshots that do exist (a board that never froze is simply absent).
 */
export async function mapLockResults(ctx: MappingContext, e: OutboxEvent, p: Payload): Promise<MappingResult> {
  const cutoffAt = await cutoffOf(ctx, e, p);
  if (!cutoffAt) return [];
  const cutoffMs = Date.parse(cutoffAt);
  // A snapshot frozen more than a day after its cutoff is an operator back-fill, not tonight's
  // lock: owners already moved on, so it is acknowledged without email.
  if (Date.parse(e.created_at) - cutoffMs > DAY_MS) return [];
  const frozen = await ctx.db.prepare('SELECT COUNT(*) AS n FROM board_snapshots WHERE cutoff_at = ?').bind(cutoffAt).first<{ n: number }>();
  if ((frozen?.n ?? 0) < BOARDS.length && ctx.nowMs - cutoffMs < CATCH_UP_DAYS * DAY_MS) return 'defer';

  // Only products whose owner had confirmed bid money counted in the snapshot: rank_units is the
  // active (confirmed, unexpired) bid total at the cutoff (src/domain/ranking.ts loadStandings).
  // Items removed from publication (suspended products) are left out.
  const { results } = await ctx.db.prepare(`SELECT s.board, i.rank, i.rank_units, p.owner_id, p.name, p.slug,
        (SELECT COUNT(*) FROM board_snapshot_items x WHERE x.snapshot_id = s.id AND x.visibility_state = 'visible') AS board_size
      FROM board_snapshots s
      JOIN board_snapshot_items i ON i.snapshot_id = s.id
      JOIN products p ON p.id = i.product_id
      WHERE s.cutoff_at = ? AND i.rank_units > 0 AND i.visibility_state = 'visible'`).bind(cutoffAt).all<LockItemRow>();

  const byOwner = new Map<string, LockItemRow[]>();
  for (const r of results) byOwner.set(r.owner_id, [...(byOwner.get(r.owner_id) ?? []), r]);

  const names = await ctx.displayNames([...byOwner.keys()]);
  const drafts: EmailDraft[] = [];
  for (const [userId, rows] of byOwner) {
    const displayName = names.get(userId) ?? null;
    if (displayName === null) continue;
    const entries: LockEntry[] = rows
      .sort((a, b) => BOARDS.indexOf(a.board) - BOARDS.indexOf(b.board) || a.rank - b.rank)
      .map(r => ({ productName: r.name, productUrl: productUrl(ctx.origin, r.slug), board: r.board, rank: r.rank, boardSize: r.board_size, rankUnits: r.rank_units }));
    drafts.push({
      userId,
      kind: 'lock_results',
      dedupeKey: `lock:${cutoffAt}:${userId}`,
      data: { kind: 'lock_results', displayName, cutoffAt, nextCutoffAt: iso(cutoffMs + DAY_MS), entries, boardsUrl: `${ctx.origin}/` },
    });
  }
  return drafts;
}
