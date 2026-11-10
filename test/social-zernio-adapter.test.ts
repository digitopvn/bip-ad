import { describe, expect, it } from 'vitest';
import { listDeadLetters } from '../src/ads/adapter-call-log';
import { retryDeadLetter } from '../src/ads/adapter-dead-letter-retry';
import { runLock } from '../src/domain/snapshot';
import { cutoffForIctDate, HOUR_MS } from '../src/lib/time';
import { publishSnapshot } from '../src/social/social-publisher';
import { buildPostRequest } from '../src/social/zernio-social-adapter';
import { cfgOf, envWith, fakeFetch, noFetch, operatorTool } from './ads-helpers';
import { bid, cfg, db, E, makeProduct, makeUser } from './helpers';

const actor = 'operator:test';
const ACCOUNTS = { x: '0123456789abcdef01234567', facebook: '1123456789abcdef01234567', youtube: '2123456789abcdef01234567', tiktok: '3123456789abcdef01234567' };
const liveEnv = () => envWith({
  SOCIAL_MODE: 'live', ZERNIO_API_KEY: 'sk_test_social',
  ZERNIO_ACCOUNT_X: ACCOUNTS.x, ZERNIO_ACCOUNT_FACEBOOK: ACCOUNTS.facebook, ZERNIO_ACCOUNT_YOUTUBE: ACCOUNTS.youtube, ZERNIO_ACCOUNT_TIKTOK: ACCOUNTS.tiktok,
});

async function lockedSnapshot(date: string) {
  const C = cutoffForIctDate(date);
  const u = await makeUser();
  await bid(u, await makeProduct(u, `Social ${date}`), 'daily', 2000, C - HOUR_MS);
  await runLock(db(), 'https://bip.test', C, C + 60_000);
  return (await db().prepare(`SELECT id FROM board_snapshots WHERE board = 'daily' AND cutoff_at = ?`).bind(new Date(C).toISOString()).first<{ id: string }>())!.id;
}

const states = async (snapshotId: string) =>
  Object.fromEntries((await db().prepare('SELECT platform, state FROM social_publications WHERE snapshot_id = ?').bind(snapshotId).all<{ platform: string; state: string }>()).results.map(r => [r.platform, r.state]));

describe('social publishing', () => {
  it('SOCIAL_MODE=mock (the default) keeps the mocked records and posts nothing', async () => {
    const snap = await lockedSnapshot('2034-01-01');
    expect(cfg().socialMode).toBe('mock');
    const r = await publishSnapshot(E, cfg(), snap, { actor, fetcher: noFetch, videoUrl: 'https://cdn.example.com/v.mp4' });
    expect(r.mode).toBe('mock');
    expect(await states(snap)).toEqual({ x: 'mocked', facebook: 'mocked', youtube: 'mocked' });
    const tool = await operatorTool('social.publish', { snapshot_id: snap });
    expect(tool.data.publications.map((p: { state: string }) => p.state)).toEqual(['mocked', 'mocked', 'mocked']);
    expect((await db().prepare('SELECT COUNT(*) AS n FROM adapter_requests WHERE adapter = ?').bind('social').first<{ n: number }>())!.n).toBe(0);
  });

  it('live mode builds the documented Zernio create-post requests per platform, with the key only in the header', async () => {
    const snap = await lockedSnapshot('2034-01-02');
    const env = liveEnv();
    const { fetcher, calls } = fakeFetch({ status: 201, body: { post: { _id: 'post_1', platforms: [{ platformPostUrl: 'https://x.com/bip_ads/status/1' }] } } });
    const r = await publishSnapshot(env, cfgOf(env), snap, { actor, fetcher, videoUrl: 'https://cdn.example.com/top10.mp4' });
    expect(r.mode).toBe('live');
    expect(calls).toHaveLength(4);
    const byPlatform = Object.fromEntries(calls.map(c => [JSON.parse(String(c.init.body)).platforms[0].platform, c]));
    expect(Object.keys(byPlatform).sort()).toEqual(['facebook', 'tiktok', 'twitter', 'youtube']);
    for (const c of calls) {
      expect(c.url).toBe('https://zernio.com/api/v1/posts');
      expect(c.init.method).toBe('POST');
      const h = c.init.headers as Record<string, string>;
      expect(h.authorization).toBe('Bearer sk_test_social');
      expect(h['idempotency-key']).toMatch(/^social:pub_/);
      const body = JSON.parse(String(c.init.body));
      expect(body.publishNow).toBe(true);
      expect(body.content).toContain(`${cfgOf(env).origin}/s/daily/2034-01-02`);
      expect(body.mediaItems).toEqual([{ type: 'video', url: 'https://cdn.example.com/top10.mp4' }]);
    }
    expect(JSON.parse(String(byPlatform.twitter.init.body)).platforms[0].accountId).toBe(ACCOUNTS.x);
    expect(JSON.parse(String(byPlatform.youtube.init.body)).platforms[0].platformSpecificData).toMatchObject({ title: 'bip.ad Daily Top 10 · 2034-01-02', visibility: 'public' });
    expect(JSON.parse(String(byPlatform.tiktok.init.body)).tiktokSettings).toMatchObject({ privacy_level: 'PUBLIC_TO_EVERYONE', content_preview_confirmed: true, express_consent_given: true });
    expect(await states(snap)).toEqual({ x: 'published', facebook: 'published', youtube: 'published', tiktok: 'published' });
    const pub = await db().prepare(`SELECT external_post_id, url FROM social_publications WHERE snapshot_id = ? AND platform = 'x'`).bind(snap).first();
    expect(pub).toEqual({ external_post_id: 'post_1', url: 'https://x.com/bip_ads/status/1' });
    // Publishing again sends nothing: every platform is already published.
    await publishSnapshot(env, cfgOf(env), snap, { actor, fetcher });
    expect(calls).toHaveLength(4);
    const leaked = await db().prepare(`SELECT COUNT(*) AS n FROM adapter_requests WHERE body_json LIKE '%sk_test%' OR url LIKE '%sk_test%'`).first<{ n: number }>();
    expect(leaked!.n).toBe(0);
  });

  it('without a video, YouTube and TikTok are blocked instead of posted; unconfigured accounts are skipped', async () => {
    const snap = await lockedSnapshot('2034-01-03');
    const env = envWith({ SOCIAL_MODE: 'live', ZERNIO_API_KEY: 'sk_test_social', ZERNIO_ACCOUNT_X: ACCOUNTS.x, ZERNIO_ACCOUNT_FACEBOOK: undefined, ZERNIO_ACCOUNT_YOUTUBE: ACCOUNTS.youtube, ZERNIO_ACCOUNT_TIKTOK: ACCOUNTS.tiktok });
    const { fetcher, calls } = fakeFetch({ status: 201, body: { post: { _id: 'p2', platforms: [] } } });
    await publishSnapshot(env, cfgOf(env), snap, { actor, fetcher });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].init.body)).mediaItems).toBeUndefined();
    expect(await states(snap)).toEqual({ x: 'published', facebook: 'not_configured', youtube: 'blocked_no_video', tiktok: 'blocked_no_video' });
  });

  it('refuses live publishing without the API key', async () => {
    const snap = await lockedSnapshot('2034-01-04');
    const env = envWith({ SOCIAL_MODE: 'live', ZERNIO_API_KEY: undefined });
    await expect(publishSnapshot(env, cfgOf(env), snap, { actor, fetcher: noFetch })).rejects.toMatchObject({ code: 'zernio_not_configured' });
  });

  it('a failed post is dead-lettered and a retry resends the same request and publishes it', async () => {
    const snap = await lockedSnapshot('2034-01-05');
    const env = envWith({ SOCIAL_MODE: 'live', ZERNIO_API_KEY: 'sk_test_social', ZERNIO_ACCOUNT_X: ACCOUNTS.x });
    const down = fakeFetch({ status: 503, body: { error: 'upstream unavailable' } });
    const r = await publishSnapshot(env, cfgOf(env), snap, { actor, fetcher: down.fetcher });
    expect(r.mode === 'live' && r.results.find(x => x.platform === 'x')).toMatchObject({ state: 'failed' });
    expect((await states(snap)).x).toBe('failed');
    const open = await listDeadLetters(db(), 'open');
    const dl = open.find(d => d.operation === 'social.publish' && d.url.endsWith('/posts'))!;
    expect(dl).toMatchObject({ adapter: 'social', failures: 1 });
    expect(dl.error).toMatch(/HTTP 503: upstream unavailable/);

    const up = fakeFetch({ status: 200, body: { post: { _id: 'post_retry', platforms: [{ platformPostUrl: 'https://x.com/bip_ads/status/9' }] } } });
    const retried = await retryDeadLetter(env, cfgOf(env), dl.id, { actor, fetcher: up.fetcher });
    expect(retried.ok).toBe(true);
    expect(up.calls[0].init.body).toBe(down.calls[0].init.body);
    expect((up.calls[0].init.headers as Record<string, string>)['idempotency-key']).toBe((down.calls[0].init.headers as Record<string, string>)['idempotency-key']);
    expect((await states(snap)).x).toBe('published');
    expect((await listDeadLetters(db(), 'resolved')).some(d => d.id === dl.id)).toBe(true);
    await expect(retryDeadLetter(env, cfgOf(env), dl.id, { actor, fetcher: up.fetcher })).rejects.toMatchObject({ code: 'not_open' });
    // Once SOCIAL_MODE is back to mock, nothing can be resent.
    const failAgain = await publishSnapshot(envWith({ ...env, ZERNIO_ACCOUNT_YOUTUBE: ACCOUNTS.youtube }), cfgOf(env), snap, { actor, fetcher: down.fetcher, videoUrl: 'https://cdn.example.com/v.mp4' });
    expect(failAgain.mode).toBe('live');
    const dl2 = (await listDeadLetters(db(), 'open')).find(d => d.resource_id !== dl.resource_id)!;
    await expect(retryDeadLetter(E, cfg(), dl2.id, { actor, fetcher: noFetch })).rejects.toMatchObject({ code: 'social_not_live' });
  });

  it('maps X to the "twitter" platform slug', () => {
    const r = buildPostRequest({ apiBase: 'https://zernio.com/api/v1', publicationId: 'pub_1', platform: 'x', accountId: ACCOUNTS.x, caption: 'c', title: 't' });
    expect(r).toMatchObject({ method: 'POST', url: 'https://zernio.com/api/v1/posts', idempotencyKey: 'social:pub_1', body: { platforms: [{ platform: 'twitter', accountId: ACCOUNTS.x }] } });
  });
});
