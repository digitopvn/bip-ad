import { config } from '../src/domain/config';
import { runLock } from '../src/domain/snapshot';
import type { Env } from '../src/env';
import { serveMcp } from '../src/mcp/common';
import { operatorMcpServer } from '../src/mcp/operator-server';
import type { Reconciler } from '../src/ads/ads-safety-controls';
import { cutoffForIctDate, HOUR_MS } from '../src/lib/time';
import { bid, db, E, makeProduct, makeUser } from './helpers';

export const healthy: Reconciler = async () => ({ balanced: true, unbalanced: [], wallet_drift: [] });
export const unbalanced: Reconciler = async () => ({ balanced: false, unbalanced: [{ txn_id: 'txn_x', currency: 'USD', s: 1 }], wallet_drift: [] });

/** Two channels: meta (min $1/day) and tiktok (min $5/day). */
export const CHANNELS = JSON.stringify([
  { channel: 'meta', accountId: 'acc_meta', adAccountId: 'act_123', minDailyMinor: 100 },
  { channel: 'tiktok', accountId: 'acc_tiktok', adAccountId: 'adv_456', minDailyMinor: 500 },
]);

export const envWith = (vars: Partial<Env>): Env => ({ ...E, ...vars });
export const cfgOf = (env: Env) => config(env);

/** Lock a cutoff with one weekly bid of `units` cents: a weekly flight with cap 80% of it. Returns the flight. */
export async function weeklyFlight(date: string, units = 7000) {
  const C = cutoffForIctDate(date);
  const u = await makeUser();
  const p = await makeProduct(u, `Ads ${date}`);
  await bid(u, p, 'weekly', units, C - HOUR_MS);
  await runLock(db(), 'https://bip.test', C, C + 60_000);
  const f = await db().prepare(`SELECT f.* FROM ad_flights f JOIN revenue_cohorts c ON c.id = f.cohort_id WHERE c.cutoff_at = ? AND f.board = 'weekly'`)
    .bind(new Date(C).toISOString()).first<{ id: string; board: string; spend_cap_minor: number; daily_cap_minor: number; committed_minor: number; spent_minor: number; state: string }>();
  if (!f) throw new Error('no flight');
  return { C, flight: f };
}

export async function flightRow(id: string) {
  return (await db().prepare('SELECT * FROM ad_flights WHERE id = ?').bind(id).first<Record<string, unknown> & { state: string; committed_minor: number; spent_minor: number; planned_minor: number }>())!;
}

let rpc = 0;
/** Call an operator MCP tool directly (no HTTP auth layer). */
export async function operatorTool(name: string, args: Record<string, unknown>, env: Env = E) {
  const req = new Request('https://bip.test/operator/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = await serveMcp(operatorMcpServer(env), req);
  const j = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { isError: !!j.result.isError, data: JSON.parse(j.result.content[0].text) };
}

/** A fetch stub that records calls and answers with the given responses in order. */
export function fakeFetch(...answers: { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetcher, calls };
}

export const noFetch = (async () => {
  throw new Error('network must not be used');
}) as typeof fetch;
