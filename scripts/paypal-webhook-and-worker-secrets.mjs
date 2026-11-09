#!/usr/bin/env node
// Non-interactive PayPal setup for one environment, for credentials already in the AgentKit vault.
// Run it through the vault so the values arrive only in its environment:
//   ak secrets run --env PAYPAL_CLIENT_ID=BIPAD_PAYPAL_CLIENT_ID_STAGING \
//     --env PAYPAL_CLIENT_SECRET=BIPAD_PAYPAL_CLIENT_SECRET_STAGING -- scripts/paypal-webhook-and-worker-secrets.mjs staging
// It checks the credentials, finds or creates the webhook for the environment, and uploads
// PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_WEBHOOK_ID to the worker (values via stdin).
// It prints the webhook id (not a credential) so it can be stored in the vault afterwards.
// scripts/setup-paypal.sh is the interactive equivalent.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENVS = {
  staging: { wranglerEnv: '', host: 'bip-ad.digitop.workers.dev', api: 'https://api-m.sandbox.paypal.com' },
  production: { wranglerEnv: 'production', host: 'bip.ad', api: 'https://api-m.paypal.com' },
};
// The events src/payments/process.ts handles; PENDING and DENIED are recorded and ignored.
const EVENTS = ['COMPLETED', 'REFUNDED', 'REVERSED', 'DENIED', 'PENDING'].map(s => ({ name: `PAYMENT.CAPTURE.${s}` }));

const envName = process.argv[2];
const target = ENVS[envName];
if (!target) {
  console.error('Usage: paypal-webhook-and-worker-secrets.mjs staging|production');
  process.exit(1);
}
const id = process.env.PAYPAL_CLIENT_ID ?? '';
const secret = process.env.PAYPAL_CLIENT_SECRET ?? '';
if (!id || !secret) {
  console.error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be in the environment.');
  process.exit(1);
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webhookUrl = `https://${target.host}/api/webhooks/paypal`;

async function paypal(method, urlPath, token, body) {
  const r = await fetch(`${target.api}${urlPath}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PayPal ${method} ${urlPath} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
}

const tokenRes = await fetch(`${target.api}/v1/oauth2/token`, {
  method: 'POST',
  headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
});
if (!tokenRes.ok) {
  console.error(`PayPal rejected the credentials (${tokenRes.status}).`);
  process.exit(1);
}
const { access_token: token } = await tokenRes.json();
console.log('credentials: accepted by PayPal');

const { webhooks = [] } = await paypal('GET', '/v1/notifications/webhooks', token);
let webhookId = webhooks.find(w => w.url === webhookUrl)?.id;
if (webhookId) {
  await paypal('PATCH', `/v1/notifications/webhooks/${webhookId}`, token, [{ op: 'replace', path: '/event_types', value: EVENTS }]);
  console.log(`webhook: reused ${webhookId} (event types refreshed)`);
} else {
  webhookId = (await paypal('POST', '/v1/notifications/webhooks', token, { url: webhookUrl, event_types: EVENTS })).id;
  console.log(`webhook: created ${webhookId}`);
}

// Run wrangler's own entry point with this Node, so no shell or PATH lookup is involved.
const wrangler = path.join(repo, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
for (const [name, value] of [['PAYPAL_CLIENT_ID', id], ['PAYPAL_CLIENT_SECRET', secret], ['PAYPAL_WEBHOOK_ID', webhookId]]) {
  execFileSync(process.execPath, [wrangler, 'secret', 'put', name, `--env=${target.wranglerEnv}`], { cwd: repo, input: value, stdio: ['pipe', 'ignore', 'inherit'] });
  console.log(`worker: ${name} uploaded`);
}
console.log(`PAYPAL_WEBHOOK_ID=${webhookId}`);
