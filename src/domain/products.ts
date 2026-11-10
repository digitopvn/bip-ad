// Products and versioned pages. Only the MCP layer calls the mutating functions here; the web has
// no product-create route (brief decision 2, A02).
import { newId, slugify } from '../lib/ids';
import { iso } from '../lib/time';
import { type Config, MODERATION_POLICY_VERSION } from './config';
import { DomainError, forbidden, isConstraintError, isGuardError, notFound } from './errors';
import { decisionStatement, guardStatement, outboxStatement } from './ledger';
import { PAGE_SCHEMA_VERSION, safeUrl, validateBlocks } from './widgets';

export interface ProductRow {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  tagline: string;
  website_url: string;
  image_url: string | null;
  status: 'draft' | 'pending_review' | 'published' | 'rejected' | 'suspended';
  is_sample: number;
  current_page_version_id: string | null;
  pending_edit_json: string | null;
  pending_page_version_id: string | null;
  version: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductInput {
  name: string;
  tagline: string;
  website_url: string;
  slug?: string;
  image_url?: string;
}

const clean = (s: string, max: number, field: string) => {
  const v = s.trim();
  if (!v || v.length > max) throw new DomainError('invalid_input', `${field} must be 1-${max} characters`);
  if (/<\s*\/?\s*[a-z]/i.test(v)) throw new DomainError('invalid_input', `${field} must be plain text`);
  return v;
};

const url = (v: string, field: string) => {
  const r = safeUrl.safeParse(v);
  if (!r.success) throw new DomainError('invalid_input', `${field} must be a public http(s) URL`);
  return r.data;
};

export async function getProduct(db: D1Database, id: string): Promise<ProductRow | null> {
  return db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<ProductRow>();
}

export async function getProductBySlug(db: D1Database, slug: string): Promise<ProductRow | null> {
  return db.prepare('SELECT * FROM products WHERE slug = ?').bind(slug).first<ProductRow>();
}

/** Loads a product and enforces ownership; a foreign product looks the same as a missing one to callers (A18). */
export async function ownedProduct(db: D1Database, userId: string, productId: string): Promise<ProductRow> {
  const p = await getProduct(db, productId);
  if (!p) throw notFound('Product not found');
  if (p.owner_id !== userId) throw forbidden('This product belongs to another account');
  return p;
}

export async function createProduct(db: D1Database, userId: string, input: ProductInput, idempotencyKey: string, nowMs = Date.now()): Promise<ProductRow> {
  const createKey = `${userId}:${idempotencyKey}`;
  const existing = await db.prepare('SELECT * FROM products WHERE create_key = ?').bind(createKey).first<ProductRow>();
  if (existing) return existing;
  const name = clean(input.name, 80, 'name');
  const tagline = clean(input.tagline, 160, 'tagline');
  const website = url(input.website_url, 'website_url');
  const image = input.image_url ? url(input.image_url, 'image_url') : null;
  const base = slugify(input.slug || name) || 'product';
  const now = iso(nowMs);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    const id = newId('prd');
    try {
      await db.batch([
        db.prepare(`INSERT INTO products (id, owner_id, slug, name, tagline, website_url, image_url, status, create_key, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`).bind(id, userId, slug, name, tagline, website, image, createKey, now, now),
        outboxStatement(db, 'ProductCreated', id, { ownerId: userId }, now),
      ]);
      return (await getProduct(db, id))!;
    } catch (e) {
      if (!isConstraintError(e)) throw e;
      const raced = await db.prepare('SELECT * FROM products WHERE create_key = ?').bind(createKey).first<ProductRow>();
      if (raced) return raced;
    }
  }
  throw new DomainError('slug_taken', 'Could not allocate a unique slug; pass a different slug');
}

/**
 * Edit product fields. Unpublished products change directly. A published product keeps its live
 * fields until the edit passes moderation: auto-approved inline only in MODERATION_MODE=screen when
 * the screen passes, otherwise stored as pending_edit_json for the operator.
 */
export async function updateProduct(db: D1Database, cfg: Config, userId: string, productId: string, patch: Partial<ProductInput>, expectedVersion?: number, nowMs = Date.now()) {
  const p = await ownedProduct(db, userId, productId);
  if (p.status === 'suspended') throw new DomainError('suspended', 'Suspended products cannot be edited', 409);
  if (expectedVersion !== undefined && expectedVersion !== p.version) throw new DomainError('version_conflict', `Product is at version ${p.version}`, 409);
  const base = p.pending_edit_json ? { ...p, ...(JSON.parse(p.pending_edit_json) as Partial<ProductRow>) } : p;
  const next = {
    name: patch.name !== undefined ? clean(patch.name, 80, 'name') : base.name,
    tagline: patch.tagline !== undefined ? clean(patch.tagline, 160, 'tagline') : base.tagline,
    website_url: patch.website_url !== undefined ? url(patch.website_url, 'website_url') : base.website_url,
    image_url: patch.image_url !== undefined ? (patch.image_url ? url(patch.image_url, 'image_url') : null) : base.image_url,
  };
  const now = iso(nowMs);
  if (p.status !== 'published') {
    const r = await db.prepare(`UPDATE products SET name = ?, tagline = ?, website_url = ?, image_url = ?, version = version + 1, updated_at = ?
                                WHERE id = ? AND version = ?`)
      .bind(next.name, next.tagline, next.website_url, next.image_url, now, p.id, p.version).run();
    if (!r.meta.changes) throw new DomainError('version_conflict', 'Product changed concurrently; read it again', 409);
    return (await getProduct(db, p.id))!;
  }
  const screen = moderationScreen(next);
  const live = cfg.autoApprove && screen.decision === 'allow';
  const r = await db.batch([
    live
      ? db.prepare(`UPDATE products SET name = ?, tagline = ?, website_url = ?, image_url = ?, pending_edit_json = NULL, version = version + 1, updated_at = ?
                    WHERE id = ? AND version = ?`).bind(next.name, next.tagline, next.website_url, next.image_url, now, p.id, p.version)
      : db.prepare('UPDATE products SET pending_edit_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
        .bind(JSON.stringify(next), now, p.id, p.version),
    decisionStatement(db, { actor: 'system:auto-moderation', action: 'products.update', decision: live ? 'allow' : 'defer', reasons: screen.reasons, policy: MODERATION_POLICY_VERSION, resourceId: p.id }, now),
  ]);
  if (!r[0].meta.changes) throw new DomainError('version_conflict', 'Product changed concurrently; read it again', 409);
  return (await getProduct(db, p.id))!;
}

function textScreen(text: string) {
  const reasons: string[] = [];
  const blob = text.toLowerCase();
  if (/\b(casino|gambl|betting|loan shark|crypto doubler|guaranteed returns?)\b/.test(blob)) reasons.push('RESTRICTED_CATEGORY');
  if (/(ignore (all|previous) instructions|system prompt|ad[_ ]?budget|spend cap)/i.test(blob)) reasons.push('PROMPT_INJECTION_SUSPECTED');
  return reasons;
}

/** Automated policy screen (mod-v1). Product text is untrusted data, never instructions. */
export function moderationScreen(p: Pick<ProductRow, 'name' | 'tagline' | 'website_url'>): { decision: 'allow' | 'defer'; reasons: string[] } {
  const reasons = textScreen(`${p.name} ${p.tagline}`);
  if (!p.website_url.startsWith('https://')) reasons.push('NON_HTTPS_DESTINATION');
  return reasons.length ? { decision: 'defer', reasons } : { decision: 'allow', reasons: ['AUTO_SCREEN_PASSED'] };
}

/** Screen a page version's text (every string value in its blocks) with the same policy. */
export function pageScreen(blocksJson: string): { decision: 'allow' | 'defer'; reasons: string[] } {
  const strings: string[] = [];
  JSON.parse(blocksJson, (_k, v) => {
    if (typeof v === 'string') strings.push(v);
    return v;
  });
  const reasons = textScreen(strings.join(' '));
  return reasons.length ? { decision: 'defer', reasons } : { decision: 'allow', reasons: ['AUTO_SCREEN_PASSED'] };
}

export async function submitProduct(db: D1Database, cfg: Config, userId: string, productId: string, nowMs = Date.now()) {
  const p = await ownedProduct(db, userId, productId);
  if (p.status === 'published' || p.status === 'pending_review') return p;
  if (p.status === 'suspended') throw new DomainError('suspended', 'Suspended products cannot be resubmitted', 409);
  if (!p.current_page_version_id) {
    const draft = await db.prepare('SELECT id FROM product_page_versions WHERE product_id = ? LIMIT 1').bind(p.id).first();
    if (!draft) throw new DomainError('page_required', 'Set page blocks with pages.set_blocks before submitting');
  }
  const now = iso(nowMs);
  const latest = await db.prepare('SELECT blocks_json FROM product_page_versions WHERE product_id = ? ORDER BY version DESC LIMIT 1').bind(p.id).first<{ blocks_json: string }>();
  const screen = moderationScreen(p);
  const page = latest ? pageScreen(latest.blocks_json) : { decision: 'allow' as const, reasons: [] };
  const reasons = [...screen.reasons.filter(r => r !== 'AUTO_SCREEN_PASSED'), ...page.reasons.filter(r => r !== 'AUTO_SCREEN_PASSED')];
  const publish = cfg.autoApprove && screen.decision === 'allow' && page.decision === 'allow';
  await db.batch([
    // The version moves on every submission so a resubmission is scored and approved as its own version.
    db.prepare(`UPDATE products SET status = ?, published_at = CASE WHEN ? THEN COALESCE(published_at, ?) ELSE published_at END, version = version + 1, updated_at = ? WHERE id = ?`)
      .bind(publish ? 'published' : 'pending_review', publish ? 1 : 0, now, now, p.id),
    // Approve the latest page draft together with the product so the public page is never empty.
    ...(publish ? publishLatestPageStatements(db, p.id, now) : []),
    decisionStatement(db, { actor: 'system:auto-moderation', action: 'products.submit', decision: publish ? 'allow' : 'defer', reasons: reasons.length ? reasons : ['AUTO_SCREEN_PASSED'], policy: MODERATION_POLICY_VERSION, resourceId: p.id }, now),
    outboxStatement(db, publish ? 'ProductApproved' : 'ProductSubmitted', p.id, { reasons }, now),
  ]);
  return (await getProduct(db, p.id))!;
}

function publishLatestPageStatements(db: D1Database, productId: string, now: string) {
  return [
    db.prepare(`UPDATE products SET current_page_version_id = COALESCE(current_page_version_id,
                (SELECT id FROM product_page_versions WHERE product_id = ? ORDER BY version DESC LIMIT 1)) WHERE id = ?`).bind(productId, productId),
    db.prepare(`UPDATE product_page_versions SET moderation_status = 'approved', published_at = COALESCE(published_at, ?)
                WHERE id = (SELECT current_page_version_id FROM products WHERE id = ?)`).bind(now, productId),
  ];
}

function approvePageStatements(db: D1Database, productId: string, pageVersionId: string, now: string, bumpVersion = false) {
  return [
    db.prepare(`UPDATE product_page_versions SET moderation_status = 'approved', published_at = COALESCE(published_at, ?) WHERE id = ? AND product_id = ?`).bind(now, pageVersionId, productId),
    db.prepare(`UPDATE products SET current_page_version_id = ?, pending_page_version_id = NULL, version = version + ?, updated_at = ? WHERE id = ?`).bind(pageVersionId, bumpVersion ? 1 : 0, now, productId),
  ];
}

/**
 * Operator moderation (operator MCP only).
 * - approve: publish, and apply any pending field edit and pending page version;
 * - reject: a published product keeps its live version and loses its pending changes; otherwise it is rejected;
 * - suspend: unpublish, and remove it from every snapshot whose media is not final (A17).
 */
export async function moderateProduct(db: D1Database, actor: string, productId: string, decision: 'approve' | 'reject' | 'suspend', reason: string, nowMs = Date.now(), expectedVersion?: number, approvableStatuses?: ProductRow['status'][]) {
  const p = await getProduct(db, productId);
  if (!p) throw notFound('Product not found');
  // Automated approvals pass the statuses they may act on, so they can never lift a suspension or a rejection.
  if (approvableStatuses && !approvableStatuses.includes(p.status)) throw new DomainError('status_conflict', `Product is ${p.status}`, 409);
  // Approving pending changes must approve exactly what the operator reviewed: the owner could
  // swap the pending edit or page between the review and the approval.
  if (decision === 'approve' && expectedVersion === undefined) {
    throw new DomainError('version_required', 'Pass the product_version you reviewed (from products.pending) to approve', 409);
  }
  if (expectedVersion !== undefined && expectedVersion !== p.version) throw new DomainError('version_conflict', 'The product changed since you reviewed it; list it again with products.pending', 409);
  const now = iso(nowMs);
  // A suspended product stays suspended when its pending changes are rejected.
  const status = decision === 'approve' ? 'published' : decision === 'suspend' ? 'suspended' : p.status === 'published' || p.status === 'suspended' ? p.status : 'rejected';
  const stmts: D1PreparedStatement[] = [
    // The guard also pins the status, so a decision taken on what was read cannot overwrite a newer one.
    guardStatement(db, 'EXISTS (SELECT 1 FROM products WHERE id = ? AND version = ? AND status = ?)', p.id, p.version, p.status),
    // Every decision moves the version: anything reviewed before it (by the operator or the AI) is stale.
    db.prepare(`UPDATE products SET status = ?, published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END, version = version + 1, updated_at = ? WHERE id = ?`)
      .bind(status, status, now, now, p.id),
  ];
  if (decision === 'approve') {
    // The pending page is the one that goes live; only without one does the latest draft (or the current page) get published.
    if (!p.pending_page_version_id) stmts.push(...publishLatestPageStatements(db, p.id, now));
    if (p.pending_edit_json) {
      const e = JSON.parse(p.pending_edit_json) as Pick<ProductRow, 'name' | 'tagline' | 'website_url' | 'image_url'>;
      stmts.push(db.prepare('UPDATE products SET name = ?, tagline = ?, website_url = ?, image_url = ?, pending_edit_json = NULL WHERE id = ?').bind(e.name, e.tagline, e.website_url, e.image_url, p.id));
    }
    if (p.pending_page_version_id) stmts.push(...approvePageStatements(db, p.id, p.pending_page_version_id, now));
  } else if (decision === 'reject') {
    stmts.push(db.prepare('UPDATE products SET pending_edit_json = NULL, pending_page_version_id = NULL WHERE id = ?').bind(p.id));
    if (p.pending_page_version_id) stmts.push(db.prepare(`UPDATE product_page_versions SET moderation_status = 'rejected' WHERE id = ? AND moderation_status = 'draft'`).bind(p.pending_page_version_id));
  } else {
    // Media is final once any social publication left the mocked/planned state (none can in this MVP).
    const { results } = await db.prepare(`SELECT DISTINCT i.snapshot_id FROM board_snapshot_items i
        WHERE i.product_id = ? AND i.visibility_state = 'visible'
          AND NOT EXISTS (SELECT 1 FROM social_publications sp WHERE sp.snapshot_id = i.snapshot_id AND sp.state NOT IN ('mocked', 'planned'))`)
      .bind(p.id).all<{ snapshot_id: string }>();
    for (const r of results) {
      stmts.push(
        db.prepare(`UPDATE board_snapshot_items SET visibility_state = 'removed_from_publication' WHERE snapshot_id = ? AND product_id = ?`).bind(r.snapshot_id, p.id),
        decisionStatement(db, { actor, action: 'snapshots.remove_from_publication', decision: 'deny', reasons: [reason || 'PRODUCT_SUSPENDED'], policy: MODERATION_POLICY_VERSION, resourceId: r.snapshot_id, result: { productId: p.id } }, now),
      );
    }
  }
  stmts.push(
    decisionStatement(db, { actor, action: 'products.moderate', decision: decision === 'approve' ? 'allow' : 'deny', reasons: [reason || decision.toUpperCase()], policy: MODERATION_POLICY_VERSION, resourceId: p.id }, now),
    outboxStatement(db, decision === 'approve' ? 'ProductApproved' : decision === 'suspend' ? 'ProductSuspended' : 'ProductRejected', p.id, { decision, reason }, now),
  );
  try {
    await db.batch(stmts);
  } catch (e) {
    if (isGuardError(e)) throw new DomainError('version_conflict', 'Product changed during moderation; review it again', 409);
    throw e;
  }
  return (await getProduct(db, p.id))!;
}

/** Products waiting for the operator: submissions and pending changes to published products. */
export async function pendingModeration(db: D1Database) {
  // The page shown is the one approval would publish: the pending version, or for a submission the latest draft.
  const { results } = await db.prepare(`SELECT p.id, p.slug, p.name, p.tagline, p.website_url, p.status, p.version, p.pending_edit_json, p.pending_page_version_id, v.version AS page_version, v.blocks_json
      FROM products p LEFT JOIN product_page_versions v ON v.id = COALESCE(p.pending_page_version_id,
        CASE WHEN p.status = 'pending_review' THEN COALESCE(p.current_page_version_id, (SELECT id FROM product_page_versions WHERE product_id = p.id ORDER BY version DESC LIMIT 1)) END)
      WHERE p.status = 'pending_review' OR p.pending_edit_json IS NOT NULL OR p.pending_page_version_id IS NOT NULL
      ORDER BY p.updated_at LIMIT 100`).all<Record<string, unknown>>();
  return results;
}

export async function setBlocks(db: D1Database, userId: string, productId: string, blocks: unknown, nowMs = Date.now()) {
  const p = await ownedProduct(db, userId, productId);
  if (p.status === 'suspended') throw new DomainError('suspended', 'Suspended products cannot be edited', 409);
  const v = validateBlocks(blocks);
  if (!v.ok) return { ok: false as const, issues: v.issues };
  const now = iso(nowMs);
  for (let attempt = 0; attempt < 3; attempt++) {
    const last = await db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM product_page_versions WHERE product_id = ?').bind(p.id).first<{ v: number }>();
    const version = (last?.v ?? 0) + 1;
    const id = newId('pgv');
    try {
      // The product version moves with every page draft so moderation can pin what it reviewed.
      await db.batch([
        db.prepare(`INSERT INTO product_page_versions (id, product_id, version, schema_version, blocks_json, moderation_status, created_at)
                    VALUES (?, ?, ?, ?, ?, 'draft', ?)`).bind(id, p.id, version, PAGE_SCHEMA_VERSION, JSON.stringify(v.blocks), now),
        db.prepare('UPDATE products SET version = version + 1, updated_at = ? WHERE id = ?').bind(now, p.id),
      ]);
      return { ok: true as const, pageVersionId: id, version };
    } catch (e) {
      if (!isConstraintError(e)) throw e;
    }
  }
  throw new DomainError('version_conflict', 'Concurrent page edits; retry', 409);
}

/**
 * Publish a page version. Before the product is public the owner may switch versions (the product
 * itself still goes through submission). For a published product the version goes live only when
 * MODERATION_MODE=screen and the page screen passes; otherwise it waits for the AI job or the operator.
 */
export async function publishPage(db: D1Database, cfg: Config, userId: string, productId: string, version: number | undefined, nowMs = Date.now()) {
  const p = await ownedProduct(db, userId, productId);
  if (p.status === 'suspended') throw new DomainError('suspended', 'Suspended products cannot be edited', 409);
  const row = await db.prepare(`SELECT id, version, blocks_json FROM product_page_versions WHERE product_id = ? ${version ? 'AND version = ?' : ''} ORDER BY version DESC LIMIT 1`)
    .bind(...(version ? [p.id, version] : [p.id])).first<{ id: string; version: number; blocks_json: string }>();
  if (!row) throw notFound('No page version to publish; call pages.set_blocks first');
  // Re-validate on publish: the schema may have tightened since the draft was saved.
  const v = validateBlocks(JSON.parse(row.blocks_json));
  if (!v.ok) return { ok: false as const, issues: v.issues };
  const now = iso(nowMs);
  const screen = pageScreen(row.blocks_json);
  const live = screen.decision === 'allow' && (p.status !== 'published' || cfg.autoApprove);
  await db.batch([
    ...(live
      ? approvePageStatements(db, p.id, row.id, now, true)
      : [db.prepare('UPDATE products SET pending_page_version_id = ?, version = version + 1, updated_at = ? WHERE id = ?').bind(row.id, now, p.id)]),
    decisionStatement(db, { actor: 'system:auto-moderation', action: 'pages.publish', decision: live ? 'allow' : 'defer', reasons: screen.reasons, policy: MODERATION_POLICY_VERSION, resourceId: row.id }, now),
    outboxStatement(db, live ? 'PagePublished' : 'PageSubmitted', p.id, { pageVersionId: row.id, version: row.version }, now),
  ]);
  return { ok: true as const, pageVersionId: row.id, version: row.version, productStatus: p.status, pendingReview: !live, reasons: screen.reasons };
}

export async function listOwnedProducts(db: D1Database, userId: string) {
  const { results } = await db.prepare('SELECT * FROM products WHERE owner_id = ? ORDER BY created_at DESC').bind(userId).all<ProductRow>();
  return results;
}

export async function pageBlocks(db: D1Database, pageVersionId: string | null) {
  if (!pageVersionId) return null;
  return db.prepare('SELECT id, version, blocks_json, moderation_status FROM product_page_versions WHERE id = ?').bind(pageVersionId)
    .first<{ id: string; version: number; blocks_json: string; moderation_status: string }>();
}
