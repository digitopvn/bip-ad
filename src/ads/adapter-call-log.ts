// Request log and dead-letter queue shared by the Zernio ads and social adapters.
// Every request is stored before it is sent (or, in a dry run, instead of being sent), keyed by its
// idempotency key: a retry resends the stored request with the same key, so a timeout never creates
// a second post or campaign. The API key is added at send time and never stored.
import { newId } from '../lib/ids';
import { iso } from '../lib/time';

export type AdapterName = 'ads' | 'social';
export type AdapterCallMode = 'dry_run' | 'live';

/** One HTTP request to the provider, exactly as it is (or would be) sent, minus the credentials. */
export interface AdapterRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  body?: unknown;
  idempotencyKey: string;
}

export interface AdapterRequestRow {
  id: string;
  adapter: AdapterName;
  operation: string;
  mode: AdapterCallMode;
  resource_id: string | null;
  idempotency_key: string;
  method: AdapterRequest['method'];
  url: string;
  body_json: string | null;
  status: 'recorded' | 'sent' | 'failed';
  attempts: number;
  response_status: number | null;
  response_json: string | null;
}

/** Live-call settings. `fetcher` is injectable so tests never reach the network. */
export interface SendOptions {
  apiKey: string | undefined;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export type SendOutcome =
  | { ok: true; status: number; response: unknown }
  | { ok: false; status: number | null; error: string };

/** Zernio REST base (docs.zernio.com quickstart: every request goes to https://zernio.com/api/v1 with a Bearer key). */
export const DEFAULT_ZERNIO_API_BASE = 'https://zernio.com/api/v1';

/** The configured base, which must be https; anything else falls back to the documented default. */
export function zernioApiBase(raw: string | undefined): string {
  const v = (raw ?? '').trim().replace(/\/+$/, '');
  try {
    if (v && new URL(v).protocol === 'https:') return v;
  } catch {
    // Not a URL: use the default.
  }
  return DEFAULT_ZERNIO_API_BASE;
}

const MAX_STORED_RESPONSE = 4000;
const MAX_ERROR = 500;
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The INSERT that stores a request (a no-op when its idempotency key is already stored). */
export function recordRequestStatement(db: D1Database, call: { adapter: AdapterName; operation: string; mode: AdapterCallMode; resourceId: string | null; request: AdapterRequest }, nowMs: number) {
  const now = iso(nowMs);
  const r = call.request;
  return db.prepare(`INSERT INTO adapter_requests (id, adapter, operation, mode, resource_id, idempotency_key, method, url, body_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?, ?) ON CONFLICT (idempotency_key) DO NOTHING`)
    .bind(newId('req'), call.adapter, call.operation, call.mode, call.resourceId, r.idempotencyKey, r.method, r.url, r.body === undefined ? null : JSON.stringify(r.body), now, now);
}

export async function requestByKey(db: D1Database, idempotencyKey: string) {
  return db.prepare('SELECT * FROM adapter_requests WHERE idempotency_key = ?').bind(idempotencyKey).first<AdapterRequestRow>();
}

/** Store the request (idempotent) and return the stored row, which may be an earlier attempt's. */
export async function recordRequest(db: D1Database, call: Parameters<typeof recordRequestStatement>[1], nowMs: number): Promise<AdapterRequestRow> {
  await recordRequestStatement(db, call, nowMs).run();
  const row = await requestByKey(db, call.request.idempotencyKey);
  if (!row) throw new Error(`adapter request ${call.request.idempotencyKey} was not stored`);
  return row;
}

/** Perform the HTTP call. Never throws: network errors and non-2xx answers come back as a failed outcome. */
export async function performRequest(row: AdapterRequestRow, o: SendOptions): Promise<SendOutcome> {
  if (!o.apiKey) return { ok: false, status: null, error: 'ZERNIO_API_KEY is not set' };
  const fetcher = o.fetcher ?? fetch;
  try {
    const res = await fetcher(row.url, {
      method: row.method,
      headers: { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': row.idempotency_key },
      body: row.body_json ?? undefined,
      signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
    });
    const text = await res.text();
    let response: unknown = text;
    try {
      response = text ? JSON.parse(text) : null;
    } catch {
      // Keep the raw text: a non-JSON answer is still evidence for the operator.
    }
    // 207 is Zernio's "partial or failed inline publish": not a success.
    if (res.ok && res.status !== 207) return { ok: true, status: res.status, response };
    const message = typeof response === 'object' && response && 'error' in response ? String((response as { error: unknown }).error) : text;
    return { ok: false, status: res.status, error: truncate(`HTTP ${res.status}: ${message}`, MAX_ERROR) };
  } catch (e) {
    return { ok: false, status: null, error: truncate(e instanceof Error ? `${e.name}: ${e.message}` : String(e), MAX_ERROR) };
  }
}

/**
 * Send a stored live request and record the outcome. On success `onSuccess` statements (the effect
 * on the domain row) commit in the same batch as the request status and the dead letter is closed;
 * on failure the request is marked failed and a dead letter is opened (or its failure count bumped).
 */
export async function sendRecorded(db: D1Database, row: AdapterRequestRow, o: SendOptions, nowMs: number,
  onSuccess: (response: unknown) => D1PreparedStatement[] = () => [], onFailure: () => D1PreparedStatement[] = () => []): Promise<SendOutcome> {
  if (row.mode !== 'live') throw new Error(`adapter request ${row.id} is a ${row.mode} record and is never sent`);
  if (row.status === 'sent') return { ok: true, status: row.response_status ?? 200, response: row.response_json ? JSON.parse(row.response_json) : null };
  const outcome = await performRequest(row, o);
  const now = iso(nowMs);
  if (outcome.ok) {
    await db.batch([
      db.prepare(`UPDATE adapter_requests SET status = 'sent', attempts = attempts + 1, response_status = ?, response_json = ?, updated_at = ? WHERE id = ?`)
        .bind(outcome.status, truncate(JSON.stringify(outcome.response ?? null), MAX_STORED_RESPONSE), now, row.id),
      db.prepare(`UPDATE adapter_dead_letters SET status = 'resolved', updated_at = ? WHERE request_id = ? AND status = 'open'`).bind(now, row.id),
      ...onSuccess(outcome.response),
    ]);
  } else {
    await db.batch([
      db.prepare(`UPDATE adapter_requests SET status = 'failed', attempts = attempts + 1, response_status = ?, response_json = ?, updated_at = ? WHERE id = ?`)
        .bind(outcome.status, JSON.stringify({ error: outcome.error }), now, row.id),
      db.prepare(`INSERT INTO adapter_dead_letters (id, request_id, error, failures, status, created_at, updated_at) VALUES (?, ?, ?, 1, 'open', ?, ?)
                  ON CONFLICT (request_id) DO UPDATE SET error = excluded.error, failures = failures + 1, status = 'open', updated_at = excluded.updated_at`)
        .bind(newId('dlq'), row.id, outcome.error, now, now),
      ...onFailure(),
    ]);
  }
  return outcome;
}

export interface DeadLetterRow {
  id: string;
  request_id: string;
  error: string;
  failures: number;
  status: 'open' | 'resolved';
  created_at: string;
  updated_at: string;
  adapter: AdapterName;
  operation: string;
  resource_id: string | null;
  method: string;
  url: string;
}

export async function listDeadLetters(db: D1Database, status: 'open' | 'resolved' = 'open', limit = 50) {
  const { results } = await db.prepare(`SELECT d.*, r.adapter, r.operation, r.resource_id, r.method, r.url FROM adapter_dead_letters d
      JOIN adapter_requests r ON r.id = d.request_id WHERE d.status = ? ORDER BY d.created_at LIMIT ?`).bind(status, limit).all<DeadLetterRow>();
  return results;
}

export async function openDeadLetterCount(db: D1Database) {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM adapter_dead_letters WHERE status = 'open'`).first<{ n: number }>())?.n ?? 0;
}

/** A stored request for display: the body parsed, never any credential (none is stored). */
export function describeRequest(row: Pick<AdapterRequestRow, 'id' | 'operation' | 'mode' | 'resource_id' | 'method' | 'url' | 'body_json' | 'status' | 'idempotency_key'>) {
  return { id: row.id, operation: row.operation, mode: row.mode, resource_id: row.resource_id, status: row.status, method: row.method, url: row.url,
    idempotency_key: row.idempotency_key, body: row.body_json ? JSON.parse(row.body_json) : null };
}
