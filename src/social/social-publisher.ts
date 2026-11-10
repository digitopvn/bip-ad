// Publishes a locked snapshot's Top 10 to the connected social accounts.
// SOCIAL_MODE=mock (default): nothing is posted; the lock's "mocked" publication records are shown as they are.
// SOCIAL_MODE=live: the operator calls social.publish after checking the video. Each platform gets
// one idempotent Zernio request; a failure is dead-lettered for adapters.retry, never re-posted blindly.
import { recordRequest, requestByKey, sendRecorded, type SendOptions, zernioApiBase } from '../ads/adapter-call-log';
import type { Board, Config } from '../domain/config';
import { DomainError } from '../domain/errors';
import { decisionStatement } from '../domain/ledger';
import type { Env } from '../env';
import { newId } from '../lib/ids';
import { ictDate, iso } from '../lib/time';
import { buildPostRequest, parsePostResponse, SOCIAL_TARGETS, type SocialPlatform, VIDEO_REQUIRED, zernioAccounts } from './zernio-social-adapter';

const POLICY = 'social-v1';

export interface PublicationRow {
  id: string;
  platform: string;
  external_post_id: string | null;
  url: string | null;
  state: string;
}

export async function publicationsOf(db: D1Database, snapshotId: string) {
  const { results } = await db.prepare('SELECT id, platform, external_post_id, url, state FROM social_publications WHERE snapshot_id = ? ORDER BY platform')
    .bind(snapshotId).all<PublicationRow>();
  return results;
}

/** Effect of an accepted create-post request on its publication row. */
export function publicationPublishedStatements(db: D1Database, publicationId: string, response: unknown): D1PreparedStatement[] {
  const { externalPostId, url } = parsePostResponse(response);
  return [db.prepare(`UPDATE social_publications SET state = 'published', external_post_id = ?, url = ? WHERE id = ?`).bind(externalPostId, url, publicationId)];
}

export function publicationFailedStatements(db: D1Database, publicationId: string): D1PreparedStatement[] {
  return [db.prepare(`UPDATE social_publications SET state = 'failed' WHERE id = ? AND state <> 'published'`).bind(publicationId)];
}

function captionFor(board: Board, date: string, snapshotUrl: string) {
  const label = `${board[0].toUpperCase()}${board.slice(1)}`;
  return {
    title: `bip.ad ${label} Top 10 · ${date}`,
    caption: `The bip.ad ${label} Top 10, locked ${date} at 03:12 ICT. Every rank was bid openly. Full board: ${snapshotUrl} #buildinpublic`,
  };
}

export interface PublishOptions {
  actor: string;
  /** Public https URL of the rendered video (YouTube and TikTok need one). */
  videoUrl?: string;
  fetcher?: typeof fetch;
  nowMs?: number;
}

export async function publishSnapshot(env: Env, cfg: Config, snapshotId: string, o: PublishOptions) {
  const db = env.DB;
  if (cfg.socialMode === 'mock') {
    return { mode: 'mock' as const, note: 'SOCIAL_MODE=mock: nothing is posted.', publications: await publicationsOf(db, snapshotId) };
  }
  if (!env.ZERNIO_API_KEY) throw new DomainError('zernio_not_configured', 'SOCIAL_MODE=live but the ZERNIO_API_KEY secret is not set; nothing was posted', 409);
  const nowMs = o.nowMs ?? Date.now();
  const now = iso(nowMs);
  const snap = await db.prepare('SELECT board, cutoff_at FROM board_snapshots WHERE id = ?').bind(snapshotId).first<{ board: Board; cutoff_at: string }>();
  if (!snap) throw new DomainError('not_found', 'Snapshot not found', 404);
  // Mocked records from the lock become pending live publications; published ones are never touched.
  await db.batch(SOCIAL_TARGETS.map(p => db.prepare(`INSERT INTO social_publications (id, snapshot_id, platform, external_post_id, url, state, created_at)
      VALUES (?, ?, ?, NULL, NULL, 'pending', ?) ON CONFLICT (snapshot_id, platform) DO UPDATE SET state = 'pending' WHERE social_publications.state = 'mocked'`)
    .bind(newId('pub'), snapshotId, p, now)));
  const rows = new Map((await publicationsOf(db, snapshotId)).map(r => [r.platform, r]));
  const date = ictDate(Date.parse(snap.cutoff_at));
  const snapshotUrl = `${cfg.origin}/s/${snap.board}/${date}`;
  const { title, caption } = captionFor(snap.board, date, snapshotUrl);
  const accounts = zernioAccounts(env);
  const send: SendOptions = { apiKey: env.ZERNIO_API_KEY, fetcher: o.fetcher };
  const results: Record<string, unknown>[] = [];

  for (const platform of SOCIAL_TARGETS) {
    const row = rows.get(platform);
    if (!row) continue;
    if (row.state === 'published') {
      results.push({ platform, state: 'published', url: row.url, note: 'already published' });
      continue;
    }
    // A request stored by an earlier attempt is resent as it was (same Idempotency-Key), so Zernio returns that post.
    const stored = await requestByKey(db, `social:${row.id}`);
    const blocked = stored ? null : blockReason(platform, accounts[platform], o.videoUrl);
    if (blocked) {
      await db.batch([
        db.prepare('UPDATE social_publications SET state = ? WHERE id = ?').bind(blocked, row.id),
        decisionStatement(db, { actor: o.actor, action: 'social.publish', decision: 'deny', reasons: [blocked.toUpperCase()], policy: POLICY, resourceId: row.id, result: { platform } }, now),
      ]);
      results.push({ platform, state: blocked });
      continue;
    }
    const request = stored ?? await recordRequest(db, {
      adapter: 'social', operation: 'social.publish', mode: 'live', resourceId: row.id,
      request: buildPostRequest({ apiBase: zernioApiBase(env.ZERNIO_API_BASE), publicationId: row.id, platform, accountId: accounts[platform]!, caption, title, videoUrl: o.videoUrl }),
    }, nowMs);
    const outcome = await sendRecorded(db, request, send, nowMs,
      response => [...publicationPublishedStatements(db, row.id, response),
        decisionStatement(db, { actor: o.actor, action: 'social.publish', decision: 'allow', reasons: ['PUBLISHED'], policy: POLICY, resourceId: row.id, result: { platform, request_id: request.id } }, now)],
      () => [...publicationFailedStatements(db, row.id),
        decisionStatement(db, { actor: o.actor, action: 'social.publish', decision: 'defer', reasons: ['ADAPTER_FAILED_DEAD_LETTERED'], policy: POLICY, resourceId: row.id, result: { platform, request_id: request.id } }, now)]);
    results.push(outcome.ok ? { platform, state: 'published', ...parsePostResponse(outcome.response) } : { platform, state: 'failed', error: outcome.error, request_id: request.id });
  }
  return { mode: 'live' as const, results, publications: await publicationsOf(db, snapshotId) };
}

/** Why a platform cannot be posted to right now, or null when it can. */
function blockReason(platform: SocialPlatform, accountId: string | undefined, videoUrl: string | undefined): 'not_configured' | 'blocked_no_video' | null {
  if (!accountId) return 'not_configured';
  if (VIDEO_REQUIRED.has(platform) && !videoUrl) return 'blocked_no_video';
  return null;
}
