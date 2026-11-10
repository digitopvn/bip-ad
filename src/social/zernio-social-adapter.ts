// Zernio social adapter: builds the create-post request for one snapshot publication.
// Request shape from docs.zernio.com (posts/create-post and the per-platform pages): POST /v1/posts
// with `content`, `mediaItems`, `platforms: [{ platform, accountId, platformSpecificData }]` and
// `publishNow`; X is platform "twitter"; YouTube takes its title in platformSpecificData.title;
// TikTok needs media and a top-level `tiktokSettings` with the consent flags. The
// `Idempotency-Key` header makes a resend return the original post instead of a duplicate.
import type { Env } from '../env';
import type { AdapterRequest } from '../ads/adapter-call-log';

/** Platforms bip.ad publishes to when SOCIAL_MODE=live. */
export const SOCIAL_TARGETS = ['x', 'facebook', 'youtube', 'tiktok'] as const;
export type SocialPlatform = (typeof SOCIAL_TARGETS)[number];

/** Zernio's platform slug for each target. */
export const ZERNIO_PLATFORM: Record<SocialPlatform, string> = { x: 'twitter', facebook: 'facebook', youtube: 'youtube', tiktok: 'tiktok' };

/** YouTube posts are exactly one video and TikTok has no text-only posts. */
export const VIDEO_REQUIRED: ReadonlySet<SocialPlatform> = new Set(['youtube', 'tiktok']);

/** Zernio account ids are 24-character hex ObjectIds. */
const ACCOUNT_ID = /^[a-f0-9]{24}$/i;

/** The connected account of each platform; a missing or malformed id means "not configured". */
export function zernioAccounts(env: Env): Partial<Record<SocialPlatform, string>> {
  const raw: Record<SocialPlatform, string | undefined> = {
    x: env.ZERNIO_ACCOUNT_X, facebook: env.ZERNIO_ACCOUNT_FACEBOOK, youtube: env.ZERNIO_ACCOUNT_YOUTUBE, tiktok: env.ZERNIO_ACCOUNT_TIKTOK,
  };
  const out: Partial<Record<SocialPlatform, string>> = {};
  for (const p of SOCIAL_TARGETS) {
    const v = raw[p]?.trim();
    if (v && ACCOUNT_ID.test(v)) out[p] = v;
  }
  return out;
}

export interface PostInput {
  apiBase: string;
  publicationId: string;
  platform: SocialPlatform;
  accountId: string;
  caption: string;
  title: string;
  /** Public https URL of the rendered video; required on YouTube and TikTok. */
  videoUrl?: string;
}

export function buildPostRequest(i: PostInput): AdapterRequest {
  const target: Record<string, unknown> = { platform: ZERNIO_PLATFORM[i.platform], accountId: i.accountId };
  if (i.platform === 'youtube') target.platformSpecificData = { title: i.title.slice(0, 100), visibility: 'public', madeForKids: false };
  const body: Record<string, unknown> = { content: i.caption, platforms: [target], publishNow: true };
  if (i.videoUrl) body.mediaItems = [{ type: 'video', url: i.videoUrl }];
  if (i.platform === 'tiktok') {
    // The operator previews the video before calling social.publish, which is what these flags attest.
    body.tiktokSettings = { privacy_level: 'PUBLIC_TO_EVERYONE', allow_comment: true, allow_duet: false, allow_stitch: false, content_preview_confirmed: true, express_consent_given: true };
  }
  return { method: 'POST', url: `${i.apiBase}/posts`, body, idempotencyKey: `social:${i.publicationId}` };
}

/** Post id and public URL from a create-post answer (`post._id`, `post.platforms[0].platformPostUrl`). */
export function parsePostResponse(response: unknown): { externalPostId: string | null; url: string | null } {
  const post = (response as { post?: { _id?: unknown; platforms?: { platformPostUrl?: unknown }[] } } | null)?.post;
  const id = typeof post?._id === 'string' ? post._id : null;
  const url = post?.platforms?.map(p => p.platformPostUrl).find((u): u is string => typeof u === 'string' && u.startsWith('https://')) ?? null;
  return { externalPostId: id, url };
}
