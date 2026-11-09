// Fetches a product's landing page for scoring. The URL is attacker-controlled, so every hop is
// re-checked (https only, no IP literals, no internal or own hostnames), redirects are followed
// manually, and size and time are capped. The extracted text is untrusted data for the models.

export interface LandingPage {
  ok: boolean;
  /** Why the page could not be read, e.g. TIMEOUT, NOT_HTML, BLOCKED_HOST. */
  error?: string;
  requestedUrl: string;
  finalUrl: string;
  redirects: number;
  status?: number;
  title?: string;
  description?: string;
  /** Visible text, whitespace-collapsed and truncated. */
  text?: string;
  /** Distinct hostnames the page links to, other than its own. */
  outboundHosts?: string[];
  contentSha256?: string;
}

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 5_000;
const MAX_BYTES = 512 * 1024;
const MAX_TEXT_CHARS = 24_000;

/** Hostnames the fetcher must never contact: loopback, private suffixes, IP literals and our own origins. */
export function blockedHost(hostname: string, ownHosts: string[]): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith('[') || h.includes(':')) return 'IP_LITERAL';
  if (!h || !h.includes('.')) return 'BLOCKED_HOST';
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/.test(h)) return 'BLOCKED_HOST';
  if (ownHosts.some(o => h === o || h.endsWith(`.${o}`))) return 'OWN_HOST';
  return null;
}

export function checkUrl(raw: string, ownHosts: string[]): { url: URL } | { error: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: 'INVALID_URL' };
  }
  if (u.protocol !== 'https:') return { error: 'NOT_HTTPS' };
  if (u.username || u.password) return { error: 'CREDENTIALS_IN_URL' };
  if (u.port && u.port !== '443') return { error: 'NON_STANDARD_PORT' };
  const blocked = blockedHost(u.hostname, ownHosts);
  return blocked ? { error: blocked } : { url: u };
}

async function readCapped(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(size, MAX_BYTES));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, out.byteLength - off);
    out.set(c.subarray(0, take), off);
    off += take;
    if (off >= out.byteLength) break;
  }
  return out;
}

const decodeEntities = (s: string) => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)));

/** Title, meta description, visible text and outbound hosts from raw HTML. Pure, so it is unit-tested. */
export function extractPage(html: string, pageUrl: URL) {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const description = decodeEntities(
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1]
    ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i)?.[1] ?? '',
  ).trim().slice(0, 500);
  const outbound = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    try {
      const h = new URL(m[1], pageUrl).hostname.toLowerCase();
      if (h && h !== pageUrl.hostname.toLowerCase()) outbound.add(h);
    } catch { /* ignore malformed links */ }
    if (outbound.size >= 50) break;
  }
  const text = decodeEntities(html
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
  return { title, description, text, outboundHosts: [...outbound] };
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export async function fetchLandingPage(rawUrl: string, ownHosts: string[], fetcher: typeof fetch = fetch): Promise<LandingPage> {
  const base: LandingPage = { ok: false, requestedUrl: rawUrl, finalUrl: rawUrl, redirects: 0 };
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = checkUrl(current, ownHosts);
    if ('error' in checked) return { ...base, finalUrl: current, redirects: hop, error: checked.error };
    let res: Response;
    try {
      res = await fetcher(checked.url.toString(), {
        redirect: 'manual',
        headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'bip.ad-moderation/1.0 (+https://bip.ad)' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      return { ...base, finalUrl: current, redirects: hop, error: e instanceof Error && e.name === 'TimeoutError' ? 'TIMEOUT' : 'FETCH_FAILED' };
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!location) return { ...base, finalUrl: current, redirects: hop, status: res.status, error: 'REDIRECT_WITHOUT_LOCATION' };
      current = new URL(location, checked.url).toString();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ...base, finalUrl: current, redirects: hop, status: res.status, error: `HTTP_${res.status}` };
    }
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!type.includes('text/html') && !type.includes('application/xhtml')) {
      await res.body?.cancel().catch(() => {});
      return { ...base, finalUrl: current, redirects: hop, status: res.status, error: 'NOT_HTML' };
    }
    const bytes = await readCapped(res);
    const html = new TextDecoder('utf-8').decode(bytes);
    return {
      ok: true, requestedUrl: rawUrl, finalUrl: current, redirects: hop, status: res.status,
      ...extractPage(html, checked.url),
      contentSha256: hex(await crypto.subtle.digest('SHA-256', bytes)),
    };
  }
  return { ...base, finalUrl: current, redirects: MAX_REDIRECTS, error: 'TOO_MANY_REDIRECTS' };
}
