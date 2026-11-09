// AI moderation of every submission and every edit, pinned to the product version it scored.
//   stage 0  regex screen (free): a hit skips the models entirely and waits for the operator;
//   stage 1  fast decision model, inline in the MCP tool call: clear injection/scam/restricted -> operator;
//   stage 2  async: landing page fetch + full decision model + evidence LLM -> verdict.
// In MODERATION_MODE=ai an "allow" verdict approves through moderateProduct with the same version
// guard the operator uses; anything else stays in products.pending with its scores. AI errors are
// retried by the hourly cron and never approve anything.
import type { Config } from '../domain/config';
import { DomainError } from '../domain/errors';
import { processEmails, REQUEST_RUN, requestRunDeadline } from '../email/process-emails';
import { decisionStatement } from '../domain/ledger';
import { moderateProduct, moderationScreen, pageScreen } from '../domain/products';
import type { Env } from '../env';
import { newId } from '../lib/ids';
import { iso } from '../lib/time';
import { chatModel, type ChatModel } from './chat-model-client';
import { decisionModel, type DecisionAnswer, type DecisionModel } from './decision-model-client';
import { fetchLandingPage, type LandingPage } from './landing-page-fetcher';
import {
  AI_MODERATION_POLICY_VERSION, EVIDENCE_SYSTEM_PROMPT, FAST_QUESTIONS, FULL_QUESTIONS, fastVerdict, fullVerdict, type LlmEvidence, parseEvidence, type Verdict,
} from './moderation-questions-and-policy';

export const AI_ACTOR = 'system:ai-moderation';
const JOB_TYPE = 'ai_moderation';
const MAX_ATTEMPTS = 3;
const STALE_RUNNING_MS = 10 * 60_000;
const MAX_PAGE_TEXT_CHARS = 12_000;
/** Total budget for the external calls of the async stage, inside the 30 s waitUntil window. */
const FULL_STAGE_BUDGET_MS = 25_000;
/** Statuses the AI may approve from. It never lifts a suspension or a rejection. */
const AI_APPROVABLE: ('pending_review' | 'published')[] = ['pending_review', 'published'];

export interface ModerationDeps {
  fast: DecisionModel;
  full: DecisionModel;
  chat: ChatModel;
  fetchPage: (url: string) => Promise<LandingPage>;
  maxRisk: number;
}

/** What the builder's agent is told after a change. */
export interface ModerationStatus {
  state: 'scoring' | 'needs_operator';
  reasons: string[];
}

/** Builds the provider clients from env; null when any of them lacks credentials. */
export function moderationDeps(env: Env, cfg: Config): ModerationDeps | null {
  const fast = decisionModel(env, (env.MODERATION_DECISION_MODEL_FAST ?? 'clef').trim() || 'clef');
  const full = decisionModel(env, (env.MODERATION_DECISION_MODEL ?? 'clef').trim() || 'clef');
  const chat = chatModel(env);
  if (!fast || !full || !chat) return null;
  const own = [new URL(cfg.origin).hostname, 'bip.ad'];
  const maxRisk = Number(env.MODERATION_APPROVE_MAX_RISK);
  return { fast, full, chat, fetchPage: url => fetchLandingPage(url, own), maxRisk: Number.isFinite(maxRisk) && maxRisk > 0 && maxRisk < 1 ? maxRisk : 0.3 };
}

interface Subject {
  productId: string;
  version: number;
  status: string;
  fields: { name: string; tagline: string; website_url: string; image_url: string | null };
  pageVersionId: string | null;
  blocksJson: string | null;
}

/** The version approval would publish: pending field edits over live fields, and the pending (or, for a submission, latest) page. */
async function loadSubject(db: D1Database, productId: string): Promise<Subject | null> {
  const p = await db.prepare(`SELECT p.id, p.version, p.status, p.name, p.tagline, p.website_url, p.image_url, p.pending_edit_json, p.pending_page_version_id,
        v.id AS page_id, v.blocks_json
      FROM products p LEFT JOIN product_page_versions v ON v.id = COALESCE(p.pending_page_version_id,
        CASE WHEN p.status = 'pending_review' THEN COALESCE(p.current_page_version_id, (SELECT id FROM product_page_versions WHERE product_id = p.id ORDER BY version DESC LIMIT 1))
             ELSE p.current_page_version_id END)
      WHERE p.id = ?`).bind(productId).first<Record<string, string | number | null>>();
  if (!p) return null;
  // Suspended, rejected and draft products are the operator's; pending fields on them are never scored.
  const awaiting = p.status === 'pending_review' || (p.status === 'published' && (p.pending_edit_json !== null || p.pending_page_version_id !== null));
  if (!awaiting) return null;
  const edit = p.pending_edit_json ? (JSON.parse(String(p.pending_edit_json)) as Subject['fields']) : null;
  return {
    productId: String(p.id),
    version: Number(p.version),
    status: String(p.status),
    fields: edit ?? { name: String(p.name), tagline: String(p.tagline), website_url: String(p.website_url), image_url: (p.image_url as string | null) ?? null },
    pageVersionId: (p.page_id as string | null) ?? null,
    blocksJson: (p.blocks_json as string | null) ?? null,
  };
}

function blocksText(blocksJson: string | null) {
  if (!blocksJson) return '';
  const strings: string[] = [];
  JSON.parse(blocksJson, (_k, v) => {
    if (typeof v === 'string') strings.push(v);
    return v;
  });
  return strings.join('\n').slice(0, MAX_PAGE_TEXT_CHARS);
}

const listingState = (s: Subject) => ({ ...s.fields, page_text: blocksText(s.blocksJson) });

const landingState = (l: LandingPage) => l.ok
  ? { final_url: l.finalUrl, redirects: l.redirects, title: l.title, description: l.description, outbound_hosts: l.outboundHosts, text: l.text?.slice(0, MAX_PAGE_TEXT_CHARS) }
  : { final_url: l.finalUrl, error: l.error };

/** JSON for the LLM prompt with "<" escaped, so untrusted text cannot close the data tags. */
const tagSafe = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

/** Rejects when the deadline passes first, so the async stage never outlives its waitUntil window. */
function beforeDeadline<T>(p: Promise<T>, deadlineMs: number, label: string): Promise<T> {
  const left = deadlineMs - Date.now();
  if (left <= 0) return Promise.reject(new Error(`${label} skipped: full stage budget spent`));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), left); });
  return Promise.race([p, timeout]).finally(() => { if (timer !== null) clearTimeout(timer); });
}

// ---------- job bookkeeping (job_runs keyed by product id + version) ----------

async function claimJob(db: D1Database, productId: string, version: number, nowMs: number) {
  const now = iso(nowMs);
  const inserted = await db.prepare(`INSERT OR IGNORE INTO job_runs (job_type, resource_id, version, status, started_at, detail) VALUES (?, ?, ?, 'running', ?, '{"attempts":1}')`)
    .bind(JOB_TYPE, productId, String(version), now).run();
  if (inserted.meta.changes) return true;
  const reclaimed = await db.prepare(`UPDATE job_runs SET status = 'running', started_at = ?, finished_at = NULL,
        detail = json_set(COALESCE(detail, '{}'), '$.attempts', COALESCE(json_extract(detail, '$.attempts'), 0) + 1)
      WHERE job_type = ? AND resource_id = ? AND version = ?
        AND (status = 'retry' OR (status = 'running' AND started_at < ?))
        AND COALESCE(json_extract(detail, '$.attempts'), 0) < ?`)
    .bind(now, JOB_TYPE, productId, String(version), iso(nowMs - STALE_RUNNING_MS), MAX_ATTEMPTS).run();
  return reclaimed.meta.changes > 0;
}

async function finishJob(db: D1Database, productId: string, version: number, status: 'done' | 'retry' | 'failed' | 'superseded', note: string) {
  await db.prepare(`UPDATE job_runs SET status = ?, finished_at = ?, detail = json_set(COALESCE(detail, '{}'), '$.note', ?) WHERE job_type = ? AND resource_id = ? AND version = ?`)
    .bind(status, iso(Date.now()), note, JOB_TYPE, productId, String(version)).run();
}

async function jobStatus(db: D1Database, productId: string, version: number) {
  const r = await db.prepare(`SELECT status FROM job_runs WHERE job_type = ? AND resource_id = ? AND version = ?`)
    .bind(JOB_TYPE, productId, String(version)).first<{ status: string }>();
  return r?.status ?? null;
}

async function attempts(db: D1Database, productId: string, version: number) {
  const r = await db.prepare(`SELECT json_extract(detail, '$.attempts') AS n FROM job_runs WHERE job_type = ? AND resource_id = ? AND version = ?`)
    .bind(JOB_TYPE, productId, String(version)).first<{ n: number | null }>();
  return r?.n ?? 0;
}

/** On an AI or network error: retry later, or hand to the operator after the last attempt. */
async function failJob(db: D1Database, s: Subject, e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  console.error('ai moderation failed', s.productId, s.version, message);
  if ((await attempts(db, s.productId, s.version)) < MAX_ATTEMPTS) return finishJob(db, s.productId, s.version, 'retry', message.slice(0, 300));
  await decisionStatement(db, { actor: AI_ACTOR, action: 'products.ai_moderation', decision: 'defer', reasons: ['AI_UNAVAILABLE'], policy: AI_MODERATION_POLICY_VERSION, resourceId: s.productId, result: { version: s.version } }, iso(Date.now())).run();
  await finishJob(db, s.productId, s.version, 'failed', message.slice(0, 300));
}

async function recordScore(db: D1Database, s: Subject, stage: 'fast' | 'full', model: DecisionModel, v: Verdict, answers: Record<string, DecisionAnswer> | null, extra: { evidence?: LlmEvidence | null; landing?: LandingPage } = {}) {
  const now = iso(Date.now());
  await db.batch([
    db.prepare(`INSERT INTO moderation_scores (id, product_id, product_version, stage, provider, model, policy_version, verdict, risk, reasons_json, answers_json, evidence_json, landing_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId('mds'), s.productId, s.version, stage, model.provider, model.model, AI_MODERATION_POLICY_VERSION, v.verdict, v.risk, JSON.stringify(v.reasons), JSON.stringify(answers ?? {}),
        extra.evidence === undefined ? null : JSON.stringify(extra.evidence), extra.landing ? JSON.stringify({ ...extra.landing, text: undefined }) : null, now),
    decisionStatement(db, { actor: AI_ACTOR, action: `products.ai_moderation.${stage}`, decision: v.verdict === 'allow' && stage === 'full' ? 'allow' : 'defer', reasons: v.reasons, policy: AI_MODERATION_POLICY_VERSION, resourceId: s.productId, result: { version: s.version, risk: v.risk } }, now),
  ]);
}

// ---------- stages ----------

/** Stage 0 + stage 1. Returns the verdict that decides whether stage 2 runs. */
async function runFastStage(db: D1Database, deps: ModerationDeps, s: Subject): Promise<Verdict> {
  const regex = [moderationScreen(s.fields), s.blocksJson ? pageScreen(s.blocksJson) : null].flatMap(r => (r && r.decision === 'defer' ? r.reasons : []));
  if (regex.length) {
    const v: Verdict = { verdict: 'defer', risk: 1, reasons: regex };
    await recordScore(db, s, 'fast', { provider: 'regex', model: 'mod-v1', ask: async () => ({}) }, v, null);
    return v;
  }
  const answers = await deps.fast.ask({ listing: listingState(s) }, FAST_QUESTIONS);
  const v = fastVerdict(answers);
  await recordScore(db, s, 'fast', deps.fast, v, answers);
  return v;
}

/** Stage 2. Approves only when the product is still at the scored version. */
async function runFullStage(db: D1Database, cfg: Config, deps: ModerationDeps, scored: Subject) {
  const s = await loadSubject(db, scored.productId);
  if (!s || s.version !== scored.version) return finishJob(db, scored.productId, scored.version, 'superseded', 'product changed before full scoring');
  const deadline = Date.now() + FULL_STAGE_BUDGET_MS;
  const landing = await beforeDeadline(deps.fetchPage(s.fields.website_url), deadline, 'landing page fetch');
  const state = { listing: listingState(s), landing_page: landingState(landing) };
  const [answers, raw] = await beforeDeadline(Promise.all([
    deps.full.ask(state, FULL_QUESTIONS),
    deps.chat.json(EVIDENCE_SYSTEM_PROMPT, `<listing>${tagSafe(state.listing)}</listing>\n<landing_page>${tagSafe(state.landing_page)}</landing_page>`),
  ]), deadline, 'full scoring');
  const evidence = parseEvidence(raw);
  const v = fullVerdict(answers, landing.ok, evidence, deps.maxRisk);
  await recordScore(db, s, 'full', deps.full, v, answers, { evidence, landing });
  if (v.verdict === 'allow' && cfg.moderationMode === 'ai') {
    try {
      await moderateProduct(db, AI_ACTOR, s.productId, 'approve', 'AI_FULL_PASSED', Date.now(), s.version, AI_APPROVABLE);
    } catch (e) {
      // The operator decided, or the builder changed it, while the AI was scoring: their version wins.
      if (e instanceof DomainError && (e.code === 'version_conflict' || e.code === 'status_conflict')) return finishJob(db, s.productId, s.version, 'superseded', 'product changed during scoring');
      throw e;
    }
  }
  await finishJob(db, s.productId, s.version, 'done', v.verdict);
}

async function runFullSafely(db: D1Database, cfg: Config, deps: ModerationDeps, s: Subject) {
  try {
    await runFullStage(db, cfg, deps, s);
  } catch (e) {
    await failJob(db, s, e);
  }
}

// ---------- entry points ----------

/**
 * Called by the user MCP after every submission or edit. Runs stages 0-1 inline and schedules
 * stage 2 with `waitUntil`. No-op in screen mode or when the product is not awaiting moderation.
 */
export async function moderateAfterChange(env: Env, cfg: Config, productId: string, waitUntil: (p: Promise<unknown>) => void, deps = moderationDeps(env, cfg)): Promise<ModerationStatus | null> {
  if (cfg.moderationMode === 'screen') return null;
  const db = env.DB;
  const s = await loadSubject(db, productId);
  if (!s) return null;
  if (!deps) return { state: 'needs_operator', reasons: ['AI_NOT_CONFIGURED'] };
  if (!(await claimJob(db, s.productId, s.version, Date.now()))) {
    // This version was already claimed: tell the agent where it actually stands.
    const status = await jobStatus(db, s.productId, s.version);
    if (status === 'running') return { state: 'scoring', reasons: ['AI_ALREADY_SCORING'] };
    if (status === 'retry') return { state: 'scoring', reasons: ['AI_RETRY_SCHEDULED'] };
    return { state: 'needs_operator', reasons: [status === 'failed' ? 'AI_UNAVAILABLE' : 'AI_ALREADY_SCORED'] };
  }
  let fast: Verdict;
  try {
    fast = await runFastStage(db, deps, s);
  } catch (e) {
    await failJob(db, s, e);
    return { state: 'scoring', reasons: ['AI_RETRY_SCHEDULED'] };
  }
  if (fast.verdict === 'defer') {
    await finishJob(db, s.productId, s.version, 'done', 'fast stage deferred');
    return { state: 'needs_operator', reasons: fast.reasons };
  }
  // The verdict may approve or reject the product: email it once the stage settles. The deadline
  // counts from now, when the waitUntil work starts, so after a slow AI stage this run only
  // projects (or does nothing) and the email cron sends.
  const emailDeadline = requestRunDeadline();
  waitUntil(runFullSafely(db, cfg, deps, s).then(() => processEmails(env, Date.now(), undefined, REQUEST_RUN, { deadlineMs: emailDeadline })));
  return { state: 'scoring', reasons: fast.reasons };
}

/** Runs both stages for one product now (cron fallback and operator rescore). */
export async function runModerationJob(env: Env, cfg: Config, productId: string, deps = moderationDeps(env, cfg), force = false) {
  const db = env.DB;
  const s = await loadSubject(db, productId);
  if (!s || !deps) return { productId, ran: false, reason: !s ? 'not_awaiting_moderation' : 'ai_not_configured' };
  if (force) {
    // A job that is still running (and not stale) keeps its claim, so a rescore never runs the same version twice at once.
    await db.prepare(`UPDATE job_runs SET status = 'retry', detail = json_set(COALESCE(detail, '{}'), '$.attempts', 0)
        WHERE job_type = ? AND resource_id = ? AND version = ? AND (status <> 'running' OR started_at < ?)`)
      .bind(JOB_TYPE, s.productId, String(s.version), iso(Date.now() - STALE_RUNNING_MS)).run();
  }
  if (!(await claimJob(db, s.productId, s.version, Date.now()))) return { productId, ran: false, reason: 'already_scored_or_running' };
  try {
    const fast = await runFastStage(db, deps, s);
    if (fast.verdict === 'defer') {
      await finishJob(db, s.productId, s.version, 'done', 'fast stage deferred');
      return { productId, ran: true, verdict: 'defer', reasons: fast.reasons };
    }
    await runFullStage(db, cfg, deps, s);
  } catch (e) {
    await failJob(db, s, e);
    return { productId, ran: true, error: e instanceof Error ? e.message : String(e) };
  }
  return { productId, ran: true, scores: await scoresFor(db, s.productId, s.version) };
}

/** Hourly fallback: score products awaiting moderation whose current version has no finished job. */
export async function sweepPendingModeration(env: Env, cfg: Config, nowMs = Date.now(), limit = 10, deps = moderationDeps(env, cfg)) {
  if (cfg.moderationMode === 'screen') return [];
  const stale = iso(nowMs - STALE_RUNNING_MS);
  // A run that died on its last attempt can never be reclaimed: hand it to the operator so it stops clogging the sweep.
  const { results: dead } = await env.DB.prepare(`UPDATE job_runs SET status = 'failed', finished_at = ?, detail = json_set(COALESCE(detail, '{}'), '$.note', 'stale after last attempt')
      WHERE job_type = ? AND status = 'running' AND started_at < ? AND COALESCE(json_extract(detail, '$.attempts'), 0) >= ?
      RETURNING resource_id, version`).bind(iso(nowMs), JOB_TYPE, stale, MAX_ATTEMPTS).all<{ resource_id: string; version: string }>();
  for (const d of dead) {
    await decisionStatement(env.DB, { actor: AI_ACTOR, action: 'products.ai_moderation', decision: 'defer', reasons: ['AI_UNAVAILABLE'], policy: AI_MODERATION_POLICY_VERSION, resourceId: d.resource_id, result: { version: Number(d.version) } }, iso(nowMs)).run();
  }
  if (!deps) return [];
  const { results } = await env.DB.prepare(`SELECT p.id FROM products p
      LEFT JOIN job_runs j ON j.job_type = ? AND j.resource_id = p.id AND j.version = CAST(p.version AS TEXT)
      WHERE (p.status = 'pending_review' OR (p.status = 'published' AND (p.pending_edit_json IS NOT NULL OR p.pending_page_version_id IS NOT NULL)))
        AND (j.status IS NULL OR j.status = 'retry' OR (j.status = 'running' AND j.started_at < ?))
      ORDER BY p.updated_at LIMIT ?`).bind(JOB_TYPE, stale, limit).all<{ id: string }>();
  const out = [];
  for (const r of results) out.push(await runModerationJob(env, cfg, r.id, deps));
  return out;
}

type ScoreRow = Record<string, string | number | null>;
const parseJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : null);
const scoreView = (r: ScoreRow) => ({
  stage: r.stage, provider: r.provider, model: r.model, verdict: r.verdict, risk: r.risk, reasons: parseJson(r.reasons_json),
  answers: parseJson(r.answers_json), evidence: parseJson(r.evidence_json), landing_page: parseJson(r.landing_json), created_at: r.created_at,
});
const jobView = (j: { status: string; detail: string | null } | undefined | null) => (j ? { status: j.status, ...parseJson(j.detail) } : null);

/** Scores of one product version, newest first, for the operator queue. */
export async function scoresFor(db: D1Database, productId: string, version: number) {
  return (await scoresForMany(db, [{ productId, version }])).get(`${productId}@${version}`)!;
}

/** Scores of many product versions in two queries per chunk (no N+1), keyed by "productId@version". */
export async function scoresForMany(db: D1Database, items: { productId: string; version: number }[]) {
  const out = new Map<string, { job: ReturnType<typeof jobView>; scores: ReturnType<typeof scoreView>[] }>();
  for (const i of items) out.set(`${i.productId}@${i.version}`, { job: null, scores: [] });
  const ids = [...new Set(items.map(i => i.productId))];
  for (let k = 0; k < ids.length; k += 50) {
    const chunk = ids.slice(k, k + 50);
    const marks = chunk.map(() => '?').join(', ');
    const [scores, jobs] = await db.batch<ScoreRow>([
      db.prepare(`SELECT product_id, product_version, stage, provider, model, verdict, risk, reasons_json, answers_json, evidence_json, landing_json, created_at
          FROM moderation_scores WHERE product_id IN (${marks}) ORDER BY created_at DESC`).bind(...chunk),
      db.prepare(`SELECT resource_id, version, status, detail FROM job_runs WHERE job_type = ? AND resource_id IN (${marks})`).bind(JOB_TYPE, ...chunk),
    ]);
    for (const r of scores.results) out.get(`${r.product_id}@${r.product_version}`)?.scores.push(scoreView(r));
    for (const j of jobs.results) {
      const entry = out.get(`${j.resource_id}@${j.version}`);
      if (entry) entry.job = jobView(j as unknown as { status: string; detail: string | null });
    }
  }
  return out;
}
