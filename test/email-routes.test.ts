import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensurePreferences, getPreferences } from '../src/email/email-preferences';
import { newId } from '../src/lib/ids';
import { iso } from '../src/lib/time';
import { db, E, makeUser } from './helpers';

const BASE = 'https://bip.test';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const switches = async (u: string) => {
  const p = (await getPreferences(db(), u))!;
  return { products: p.products, boards: p.boards, referrals: p.referrals };
};

async function signedIn(userId: string) {
  const sid = newId('sid');
  const csrf = newId('csrf');
  await E.OAUTH_KV.put(`session:${sid}`, JSON.stringify({ userId, csrf }));
  return { cookie: `bip_session=${sid}`, csrf };
}

describe('unsubscribe link', () => {
  it('GET only shows a confirmation; the one-click POST switches the group off', async () => {
    const u = await makeUser('Reader');
    const { unsubscribeToken: t } = await ensurePreferences(db(), u);
    const url = `${BASE}/email/unsubscribe?t=${t}&g=boards`;
    const page = await SELF.fetch(url);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('method="post"');
    expect(body).toContain(`action="/email/unsubscribe?t=${t}&amp;g=boards"`);
    expect(await switches(u)).toEqual({ products: true, boards: true, referrals: true });

    const done = await SELF.fetch(url, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: FORM });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('You are unsubscribed');
    expect(await switches(u)).toEqual({ products: true, boards: false, referrals: true });
  });

  it('g=all switches every group off', async () => {
    const u = await makeUser('Leaver');
    const { unsubscribeToken: t } = await ensurePreferences(db(), u);
    expect((await SELF.fetch(`${BASE}/email/unsubscribe?t=${t}&g=all`, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: FORM })).status).toBe(200);
    expect(await switches(u)).toEqual({ products: false, boards: false, referrals: false });
  });

  it('an unknown token or group is a 404 with the same message and changes nothing', async () => {
    const u = await makeUser('Untouched');
    const { unsubscribeToken: t } = await ensurePreferences(db(), u);
    const bodies = [];
    for (const [method, q] of [['GET', `t=${'x'.repeat(32)}&g=boards`], ['POST', `t=${'x'.repeat(32)}&g=boards`], ['POST', `t=${t}&g=welcome`], ['GET', 'g=boards']] as const) {
      const r = await SELF.fetch(`${BASE}/email/unsubscribe?${q}`, { method, ...(method === 'POST' ? { body: 'List-Unsubscribe=One-Click', headers: FORM } : {}) });
      expect(r.status, `${method} ${q}`).toBe(404);
      bodies.push((await r.text()).includes('This unsubscribe link is not valid.'));
    }
    expect(bodies).toEqual([true, true, true, true]);
    expect(await switches(u)).toEqual({ products: true, boards: true, referrals: true });
  });
});

describe('/account email preferences', () => {
  it('shows the address and switches, and saves them only with the session CSRF token', async () => {
    const u = await makeUser('Account Holder', 'holder@example.test');
    const { cookie, csrf } = await signedIn(u);
    const page = await SELF.fetch(`${BASE}/account`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('holder@example.test');
    expect(html).toMatch(/name="boards" value="1" checked/);
    expect(html).toContain('always sent');

    const save = (body: string, c = cookie) => SELF.fetch(`${BASE}/account/email`, { method: 'POST', redirect: 'manual', body, headers: { ...FORM, cookie: c } });
    expect((await save('csrf=wrong&products=1')).status).toBe(403);
    expect((await save(`csrf=${csrf}&products=1`, '')).status).toBe(403);
    expect(await getPreferences(db(), u)).toBeNull();

    const ok = await save(`csrf=${csrf}&products=1&referrals=1`);
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/account?email=saved#email');
    expect(await switches(u)).toEqual({ products: true, boards: false, referrals: true });
    const after = await SELF.fetch(`${BASE}/account?email=saved`, { headers: { cookie } }).then(r => r.text());
    expect(after).toContain('Email preferences saved.');
    expect(after).not.toMatch(/name="boards" value="1" checked/);
  });

  it('says so when no email address is on file', async () => {
    const u = await makeUser('No Address');
    await db().prepare('UPDATE users SET email = NULL WHERE id = ?').bind(u).run();
    const { cookie } = await signedIn(u);
    expect(await SELF.fetch(`${BASE}/account`, { headers: { cookie } }).then(r => r.text())).toContain('No email address is on file');
  });
});

describe('operator emails.list', () => {
  it('lists recent emails without bodies, filtered by status, user and kind', async () => {
    const u = await makeUser('Listed');
    const now = Date.now();
    const insert = (kind: string, status: string, offsetMs: number) => db().prepare(`INSERT INTO email_outbox (id, user_id, kind, dedupe_key, to_address, data_json, status, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'listed@example.test', '{"secret":"body"}', ?, ?, ?, ?)`).bind(newId('eml'), u, kind, newId('d'), status, iso(now + 365 * 86400_000), iso(now + offsetMs), iso(now + offsetMs)).run();
    await insert('welcome', 'sent', 0);
    await insert('bid_receipt', 'failed', 1000);
    await insert('bid_receipt', 'skipped', 2000);
    const call = async (args: Record<string, unknown>) => {
      const r = await SELF.fetch(`${BASE}/operator/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer test-operator-token-0123456789abcdef0123' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'emails.list', arguments: args } }),
      });
      const j = await r.json() as { result: { content: { text: string }[] } };
      return (JSON.parse(j.result.content[0].text) as { emails: Record<string, unknown>[] }).emails;
    };
    const mine = await call({ user_id: u });
    expect(mine.map(e => [e.kind, e.status])).toEqual([['bid_receipt', 'skipped'], ['bid_receipt', 'failed'], ['welcome', 'sent']]);
    expect(Object.keys(mine[0]).sort()).toEqual(['attempts', 'created_at', 'id', 'kind', 'last_error', 'provider_message_id', 'sent_at', 'skip_reason', 'status', 'to_address', 'user_id']);
    expect((await call({ user_id: u, status: 'failed' })).map(e => e.kind)).toEqual(['bid_receipt']);
    expect((await call({ user_id: u, kind: 'welcome' })).map(e => e.status)).toEqual(['sent']);
    expect(await call({ user_id: u, limit: 1 })).toHaveLength(1);
  });
});
