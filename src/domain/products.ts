// Products and versioned pages. Only the MCP layer calls the mutating functions here; the web has
// no product-create route (brief decision 2, A02).
import { newId, slugify } from '../lib/ids';
import { iso } from '../lib/time';
import { type Config, MODERATION_POLICY_VERSION } from './config';
import { DomainError, forbidden, isConstraintError, notFound } from './errors';
import { decisionStatement, outboxStatement } from './ledger';
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

export async function updateProduct(db: D1Database, userId: string, productId: string, patch: Partial<ProductInput>, expectedVersion?: number, nowMs = Date.now()) {
  const p = await ownedProduct(db, userId, productId);
  if (p.status === 'suspended') throw new DomainError('suspended', 'Suspended products cannot be edited', 409);
  if (expectedVersion !== undefined && expectedVersion !== p.version) throw new DomainError('version_conflict', `Product is at version ${p.version}`, 409);
  const next = {
    name: patch.name !== undefined ? clean(patch.name, 80, 'name') : p.name,
    tagline: patch.tagline !== undefined ? clean(patch.tagline, 160, 'tagline') : p.tagline,
    website_url: patch.website_url !== undefined ? url(patch.website_url, 'website_url') : p.website_url,
    image_url: patch.image_url !== undefined ? (patch.image_url ? url(patch.image_url, 'image_url') : null) : p.image_url,
  };
  const r = await db.prepare(`UPDATE products SET name = ?, tagline = ?, website_url = ?, image_url = ?, version = version + 1, updated_at = ?
                              WHERE id = ? AND version = ?`)
    .bind(next.name, next.tagline, next.website_url, next.image_url, iso(nowMs), p.id, p.version).run();
  if (!r.meta.changes) throw new DomainError('version_conflict', 'Product changed concurrently; read it again', 409);
  return (await getProduct(db, p.id))!;
}

/** Automated policy screen (mod-v1). Product text is untrusted data, never instructions. */
export function moderationScreen(p: Pick<ProductRow, 'name' | 'tagline' | 'website_url'>): { decision: 'allow' | 'defer'; reasons: string[] } {
  const reasons: string[] = [];
  const blob = `${p.name} ${p.tagline}`.toLowerCase();
  if (/\b(casino|gambl|betting|loan shark|crypto doubler|guaranteed returns?)\b/.test(blob)) reasons.push('RESTRICTED_CATEGORY');
  if (/(ignore (all|previous) instructions|system prompt|ad[_ ]?budget|spend cap)/i.test(blob)) reasons.push('PROMPT_INJECTION_SUSPECTED');
  if (!p.website_url.startsWith('https://')) reasons.push('NON_HTTPS_DESTINATION');
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
  const screen = moderationScreen(p);
  const publish = cfg.autoApprove && screen.decision === 'allow';
  await db.batch([
    db.prepare(`UPDATE products SET status = ?, published_at = CASE WHEN ? THEN COALESCE(published_at, ?) ELSE published_at END, updated_at = ? WHERE id = ?`)
      .bind(publish ? 'published' : 'pending_review', publish ? 1 : 0, now, now, p.id),
    // Approve the latest page draft together with the product so the public page is never empty.
    ...(publish ? publishLatestPageStatements(db, p.id, now) : []),
    decisionStatement(db, { actor: 'system:auto-moderation', action: 'products.submit', decision: publish ? 'allow' : 'defer', reasons: screen.reasons, policy: MODERATION_POLICY_VERSION, resourceId: p.id }, now),
    outboxStatement(db, publish ? 'ProductApproved' : 'ProductSubmitted', p.id, { reasons: screen.reasons }, now),
  ]);
  return (await getProduct(db, p.id))!;
}

function publishLatestPageStatements(db: D1Database, productId: string, now: string) {
  return [
    db.prepare(`UPDATE product_page_versions SET moderation_status = 'approved', published_at = COALESCE(published_at, ?)
                WHERE id = (SELECT id FROM product_page_versions WHERE product_id = ? ORDER BY version DESC LIMIT 1)`).bind(now, productId),
    db.prepare(`UPDATE products SET current_page_version_id = COALESCE(current_page_version_id,
                (SELECT id FROM product_page_versions WHERE product_id = ? ORDER BY version DESC LIMIT 1)) WHERE id = ?`).bind(productId, productId),
  ];
}

/** Operator moderation (operator MCP only). */
export async function moderateProduct(db: D1Database, actor: string, productId: string, decision: 'approve' | 'reject' | 'suspend', reason: string, nowMs = Date.now()) {
  const p = await getProduct(db, productId);
  if (!p) throw notFound('Product not found');
  const now = iso(nowMs);
  const status = decision === 'approve' ? 'published' : decision === 'reject' ? 'rejected' : 'suspended';
  await db.batch([
    db.prepare('UPDATE products SET status = ?, published_at = CASE WHEN ? = \'published\' THEN COALESCE(published_at, ?) ELSE published_at END, updated_at = ? WHERE id = ?')
      .bind(status, status, now, now, p.id),
    ...(decision === 'approve' ? publishLatestPageStatements(db, p.id, now) : []),
    decisionStatement(db, { actor, action: 'products.moderate', decision: decision === 'approve' ? 'allow' : 'deny', reasons: [reason || decision.toUpperCase()], policy: MODERATION_POLICY_VERSION, resourceId: p.id }, now),
    outboxStatement(db, decision === 'approve' ? 'ProductApproved' : 'ProductRejected', p.id, { decision, reason }, now),
  ]);
  return (await getProduct(db, p.id))!;
}

export async function setBlocks(db: D1Database, userId: string, productId: string, blocks: unknown, nowMs = Date.now()) {
  const p = await ownedProduct(db, userId, productId);
  const v = validateBlocks(blocks);
  if (!v.ok) return { ok: false as const, issues: v.issues };
  const now = iso(nowMs);
  for (let attempt = 0; attempt < 3; attempt++) {
    const last = await db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM product_page_versions WHERE product_id = ?').bind(p.id).first<{ v: number }>();
    const version = (last?.v ?? 0) + 1;
    const id = newId('pgv');
    try {
      await db.prepare(`INSERT INTO product_page_versions (id, product_id, version, schema_version, blocks_json, moderation_status, created_at)
                        VALUES (?, ?, ?, ?, ?, 'draft', ?)`).bind(id, p.id, version, PAGE_SCHEMA_VERSION, JSON.stringify(v.blocks), now).run();
      return { ok: true as const, pageVersionId: id, version };
    } catch (e) {
      if (!isConstraintError(e)) throw e;
    }
  }
  throw new DomainError('version_conflict', 'Concurrent page edits; retry', 409);
}

export async function publishPage(db: D1Database, userId: string, productId: string, version: number | undefined, nowMs = Date.now()) {
  const p = await ownedProduct(db, userId, productId);
  const row = await db.prepare(`SELECT id, version, blocks_json FROM product_page_versions WHERE product_id = ? ${version ? 'AND version = ?' : ''} ORDER BY version DESC LIMIT 1`)
    .bind(...(version ? [p.id, version] : [p.id])).first<{ id: string; version: number; blocks_json: string }>();
  if (!row) throw notFound('No page version to publish; call pages.set_blocks first');
  // Re-validate on publish: the schema may have tightened since the draft was saved.
  const v = validateBlocks(JSON.parse(row.blocks_json));
  if (!v.ok) return { ok: false as const, issues: v.issues };
  const now = iso(nowMs);
  await db.batch([
    db.prepare(`UPDATE product_page_versions SET moderation_status = 'approved', published_at = COALESCE(published_at, ?) WHERE id = ?`).bind(now, row.id),
    db.prepare('UPDATE products SET current_page_version_id = ?, updated_at = ? WHERE id = ?').bind(row.id, now, p.id),
    outboxStatement(db, 'PagePublished', p.id, { pageVersionId: row.id, version: row.version }, now),
  ]);
  return { ok: true as const, pageVersionId: row.id, version: row.version, productStatus: p.status };
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
