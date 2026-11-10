import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { executeFlights, ingestHourlyMetrics, planDueFlights } from '../src/ads/ads-flight-operations';
import type { EmailTransport, OutgoingEmail } from '../src/email/email-transport';
import { cutoffForIctDate, HOUR_MS } from '../src/lib/time';
import { detectAlerts, enqueueAlerts, sendOperatorAlerts } from '../src/monitoring/operator-alerts';
import { CHANNELS, cfgOf, envWith, healthy, noFetch, weeklyFlight } from './ads-helpers';
import { db } from './helpers';

const BASE = 'https://bip.test';
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36' };

describe('site footer', () => {
  it('links the four bip.ad social accounts accessibly and the transparency page from every page', async () => {
    for (const path of ['/', '/daily', '/terms']) {
      const html = await (await SELF.fetch(BASE + path, { headers: UA })).text();
      for (const [href, name] of [
        ['https://www.tiktok.com/@bip.ad', 'bip.ad on TikTok'],
        ['https://www.youtube.com/@bipads', 'bip.ad on YouTube'],
        ['https://x.com/bip_ads', 'bip.ad on X'],
        ['https://www.facebook.com/buildinpublic.ad/', 'bip.ad on Facebook'],
      ]) {
        expect(html, `${path} ${href}`).toContain(`<a href="${href}" rel="me noopener" aria-label="${name}">`);
      }
      expect(html, path).toContain('<ul class="footer-social" aria-label="bip.ad on social media">');
      expect(html, path).toContain('<a href="/transparency">Transparency</a>');
    }
  });
});

describe('transparency page', () => {
  it('labels the dry run and shows per-board funds, caps, as_of_at and the source of every figure', async () => {
    const { C, flight } = await weeklyFlight('2035-01-01');
    const env = envWith({ ZERNIO_ADS_ACCOUNTS: CHANNELS });
    await planDueFlights(env, cfgOf(env), { actor: 'operator:test', nowMs: C + HOUR_MS });
    await executeFlights(env, cfgOf(env), healthy, { actor: 'operator:test', nowMs: C + HOUR_MS, flightId: flight.id, fetcher: noFetch });
    await ingestHourlyMetrics(db(), C + HOUR_MS);
    const r = await SELF.fetch(`${BASE}/transparency`, { headers: UA });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('<strong>Dry run.</strong>');
    expect(html).toContain('Transparency · dry run');
    expect(html).toContain('Figures as of');
    expect(html).toContain('Source: bip.ad ledger and ad flight records (D1)');
    expect(html).toContain('Ads mode: dry run');
    expect(html).toContain('$56.00'); // weekly spend cap: 80% of the $70 bid
    expect(html).toContain('$8.00'); // daily cap
    expect(html).toContain('Running (dry run)');
    expect(html).toContain('No data: dry run, no ad provider connected');
    expect(html).toContain(`datetime="${new Date(C + HOUR_MS).toISOString()}"`);
  });
});

describe('operator alerts', () => {
  const fakeTransport = () => {
    const sent: OutgoingEmail[] = [];
    const t: EmailTransport = { async send(m) { sent.push(m); return { messageId: `m${sent.length}` }; } };
    return { t, sent };
  };

  it('detects an unbalanced ledger, a missed lock and open dead letters, queues each once per period and mails them', async () => {
    const now = cutoffForIctDate('2035-02-01') + 3 * HOUR_MS; // nothing locked this cutoff
    await db().prepare(`INSERT INTO adapter_requests (id, adapter, operation, mode, resource_id, idempotency_key, method, url, body_json, status, created_at, updated_at)
        VALUES ('req_alert', 'social', 'social.publish', 'live', 'pub_x', 'social:pub_x', 'POST', 'https://zernio.com/api/v1/posts', '{}', 'failed', ?, ?)`).bind(new Date(now).toISOString(), new Date(now).toISOString()).run();
    await db().prepare(`INSERT INTO adapter_dead_letters (id, request_id, error, status, created_at, updated_at) VALUES ('dlq_alert', 'req_alert', 'HTTP 500', 'open', ?, ?)`)
      .bind(new Date(now).toISOString(), new Date(now).toISOString()).run();
    const alerts = await detectAlerts(db(), { balanced: false, unbalanced: [{}], wallet_drift: [] }, now);
    expect(alerts.map(a => a.kind).sort()).toEqual(['dead_letters_open', 'lock_missed', 'reconcile_unbalanced']);
    await enqueueAlerts(db(), alerts, now);
    await enqueueAlerts(db(), alerts, now + 60_000);
    const queued = await db().prepare(`SELECT COUNT(*) AS n FROM operator_alerts WHERE status = 'pending'`).first<{ n: number }>();
    expect(queued!.n).toBe(3);

    // Without a recipient nothing is sent and the alerts wait.
    const none = fakeTransport();
    expect(await sendOperatorAlerts(envWith({ OPERATOR_ALERT_EMAIL: undefined }), 'https://bip.ad', now, none.t)).toMatchObject({ waiting: true });
    expect(none.sent).toHaveLength(0);
    const mail = fakeTransport();
    const r = await sendOperatorAlerts(envWith({ OPERATOR_ALERT_EMAIL: 'ops@example.test', EMAIL_FROM: 'bip.ad <hello@bip.ad>' }), 'https://bip.ad', now, mail.t);
    expect(r).toMatchObject({ sent: 3, failed: 0 });
    expect(mail.sent.every(m => m.to === 'ops@example.test' && m.subject.startsWith('[bip.ad alert]'))).toBe(true);
    expect(mail.sent.map(m => m.subject).join('\n')).toMatch(/reconciliation is unbalanced/);
    expect((await db().prepare(`SELECT COUNT(*) AS n FROM operator_alerts WHERE status = 'sent'`).first<{ n: number }>())!.n).toBe(3);
  });
});
