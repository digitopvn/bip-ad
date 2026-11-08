// Browser check for the rendered views: console errors, failed same-origin requests, horizontal overflow
// at 1440 and 375, first-screen screenshots, plus a live-poll + impression-beacon test on the homepage.
// Usage: node check-views.mjs <renderedDir> <shotsDir>   (serves public/ at the root on port 8791)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8791;
const PUBLIC = new URL('../../../public/', import.meta.url);
const [renderedDir, shotsDir] = process.argv.slice(2);
if (!renderedDir || !shotsDir) { console.error('usage: node check-views.mjs <renderedDir> <shotsDir>'); process.exit(2); }
mkdirSync(shotsDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.json': 'application/json' };

// Polled board: Commitly (#9) jumps to #1, everything else shifts down one.
const pollRows = () => {
  const html = readFileSync(join(renderedDir, 'home.html'), 'utf8');
  const panel = html.slice(html.indexOf('id="panel-daily"'), html.indexOf('id="panel-weekly"'));
  const items = [...panel.matchAll(/data-product-id="([^"]+)" data-bid="(\d+)" data-rank="(\d+)"/g)].map((m) => ({ productId: m[1], activeRankUnits: Number(m[2]), rank: Number(m[3]) }));
  const mover = items.find((r) => r.productId === 'p_commitly');
  const rest = items.filter((r) => r !== mover);
  return [{ ...mover, activeRankUnits: 60000, rank: 1 }, ...rest.map((r, i) => ({ ...r, rank: i + 2 }))].map((r) => ({
    ...r, slug: r.productId.slice(2), name: r.productId, tagline: '', ownerSuccessfulReferrals: 0, validClicks: 0, validViews: 0, isSample: true, imageUrl: null,
  }));
};
let beacons = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname.startsWith('/api/boards/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ rows: pollRows() })); return; }
  if (url.pathname === '/api/events' && req.method === 'POST') { beacons += 1; req.resume(); res.writeHead(204); res.end(); return; }
  let file;
  if (url.pathname.startsWith('/__views/')) file = join(renderedDir, normalize(url.pathname.slice('/__views/'.length)));
  else file = join(PUBLIC.pathname.replace(/^\/([A-Za-z]:)/, '$1'), normalize(decodeURIComponent(url.pathname)));
  if (!file.includes('..') && existsSync(file) && !file.endsWith('/') && extname(file)) {
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));

const profile = mkdtempSync(join(tmpdir(), 'bipad-views-'));
const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let exitCode = 0;
try {
  const wsUrl = await new Promise((ok, fail) => {
    let buf = ''; const t = setTimeout(() => fail(new Error('no devtools')), 20000);
    proc.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  });
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map(); const listeners = [];
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.fail(new Error(m.error.message)) : p.ok(m.result); } else listeners.forEach((l) => l(m)); };
  await new Promise((r) => { ws.onopen = r; });
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => { const i = ++id; pending.set(i, { ok, fail }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const evaluate = async (sessionId, expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;

  const open = async (page, w, h) => {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const errors = [], failed = [];
    listeners.push((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
      if (m.method === 'Network.responseReceived') {
        const { url, status } = m.params.response;
        if (status >= 400 && url.startsWith(`http://127.0.0.1:${PORT}/`) && !url.includes('missing-demo.mp4')) failed.push(`${status} ${url}`);
      }
    });
    await send('Runtime.enable', {}, sessionId);
    await send('Network.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 }, sessionId);
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/__views/${page}.html` }, sessionId);
    await sleep(1800);
    return { targetId, sessionId, errors, failed };
  };

  // Overflow is measured with the clip guard disabled so real offenders are visible.
  const OVERFLOW_JS = `(() => {
    const s = document.createElement('style'); s.textContent = 'html,body{overflow-x:visible!important}'; document.head.append(s);
    const sw = document.documentElement.scrollWidth, iw = window.innerWidth;
    const offenders = [];
    if (sw > iw + 1) document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.right > iw + 1 && r.width > 0 && !el.closest('.table-wrap,.acct-nav,.bg-canvas,svg') && getComputedStyle(el).position !== 'fixed') offenders.push(el.tagName.toLowerCase() + '.' + [...el.classList].join('.') + ' r=' + Math.round(r.right));
    });
    s.remove();
    return { sw, iw, offenders: offenders.slice(0, 8) };
  })()`;

  const pages = readdirSync(renderedDir).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)).sort();
  for (const page of pages) {
    for (const [w, h] of [[1440, 900], [375, 812]]) {
      const { targetId, sessionId, errors, failed } = await open(page, w, h);
      const o = await evaluate(sessionId, OVERFLOW_JS);
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(join(shotsDir, `${page}-${w}.png`), Buffer.from(data, 'base64'));
      const problems = [...errors.map((e) => `console: ${e}`), ...failed.map((f) => `request: ${f}`), ...(o.sw > o.iw + 1 ? [`overflow ${o.sw}>${o.iw}: ${o.offenders.join(', ')}`] : [])];
      if (problems.length) exitCode = 1;
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${page} @${w}${problems.length ? '\n     ' + problems.join('\n     ') : ''}`);
      await send('Target.closeTarget', { targetId });
    }
  }

  // Live poll + beacons on the homepage (the first poll fires 30s after load).
  {
    const { targetId, sessionId, errors } = await open('home', 1440, 900);
    await evaluate(sessionId, `document.getElementById('board').scrollIntoView()`);
    const before = await evaluate(sessionId, `document.querySelector('#panel-daily .list-main .item').dataset.productId`);
    const tabs = await evaluate(sessionId, `(() => { const t = document.querySelector('[data-tabs]'); return t.getAttribute('role') + ':' + [...t.querySelectorAll('[role=tab]')].map(x => x.getAttribute('aria-selected')).join(','); })()`);
    await evaluate(sessionId, `document.getElementById('tab-weekly').click()`);
    const weeklyShown = await evaluate(sessionId, `!document.getElementById('panel-weekly').hidden && document.getElementById('panel-daily').hidden && location.pathname.endsWith('home.html')`);
    await evaluate(sessionId, `document.getElementById('tab-daily').click()`);
    await sleep(32000);
    const after = await evaluate(sessionId, `(() => { const li = document.querySelector('#panel-daily .list-main .item'); return li.dataset.productId + ' ' + li.dataset.tier + ' ' + li.querySelector('[data-amt]').textContent + ' ' + li.querySelector('[data-rank-text]').textContent; })()`);
    const ticker = await evaluate(sessionId, `document.querySelector('[data-ticker]').textContent`);
    const ok = before !== 'p_commitly' && after.startsWith('p_commitly lead $600.00 Rank 1') && tabs === 'tablist:true,false,false' && weeklyShown && beacons > 0 && !errors.length;
    if (!ok) exitCode = 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} live: tabs=${tabs} weeklyTab=${weeklyShown} before=${before} after="${after}" ticker="${ticker}" beacons=${beacons} errors=${errors.length}`);
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(join(shotsDir, 'home-after-poll-1440.png'), Buffer.from(data, 'base64'));
    await send('Target.closeTarget', { targetId });
  }
  ws.close();
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  proc.kill();
  server.close();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* profile still locked */ }
}
process.exit(exitCode);
