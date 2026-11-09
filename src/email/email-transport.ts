// Delivery seam: production sends through the Cloudflare Email Service binding (env.EMAIL);
// tests inject a fake with the same interface.

export interface OutgoingEmail {
  from: string | EmailAddress;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export interface EmailTransport {
  /** Resolves with the provider message id; rejects when the provider refused the message. */
  send(message: OutgoingEmail): Promise<{ messageId: string }>;
}

export function bindingTransport(binding: SendEmail): EmailTransport {
  return {
    async send(m) {
      const r = await binding.send({
        from: m.from, to: m.to, subject: m.subject, html: m.html, text: m.text,
        ...(m.replyTo ? { replyTo: m.replyTo } : {}),
        ...(m.headers && Object.keys(m.headers).length ? { headers: m.headers } : {}),
      });
      return { messageId: r.messageId };
    },
  };
}

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Parse EMAIL_FROM: "Name <addr@host>" becomes { name, email }; a bare address stays a string. Null when unusable. */
export function parseFromAddress(raw: string | undefined): string | EmailAddress | null {
  const v = raw?.trim();
  if (!v) return null;
  const m = /^(.*?)\s*<([^<>]+)>$/.exec(v);
  if (m) {
    const email = m[2].trim();
    const name = m[1].trim().replace(/^"(.*)"$/, '$1');
    if (!ADDRESS.test(email)) return null;
    return name ? { name, email } : email;
  }
  return ADDRESS.test(v) ? v : null;
}

/** Production is https://bip.ad (or www); every other origin is a staging or dev deployment. */
export function subjectPrefixFor(origin: string): string {
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' && (u.hostname === 'bip.ad' || u.hostname === 'www.bip.ad') ? '' : '[staging] ';
  } catch {
    return '[staging] ';
  }
}
