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

/**
 * Email Service errors that retrying cannot fix: the message or its recipient is invalid
 * (https://developers.cloudflare.com/email-service/api/send-emails/workers-api/ "Error handling").
 * The sender ones are configuration errors on our side; they fail fast so the operator sees them
 * in emails.list instead of the queue retrying for hours. Rate limits, daily limits, account
 * pauses, delivery and internal errors stay retryable.
 */
export const PERMANENT_SEND_ERROR_CODES: ReadonlySet<string> = new Set([
  'E_VALIDATION_ERROR', 'E_FIELD_MISSING', 'E_TOO_MANY_RECIPIENTS', 'E_TOO_MANY_ATTACHMENTS',
  'E_SENDER_NOT_VERIFIED', 'E_SENDER_DOMAIN_NOT_AVAILABLE', 'E_RECIPIENT_NOT_ALLOWED', 'E_RECIPIENT_SUPPRESSED', 'E_CONTENT_TOO_LARGE',
  'E_HEADER_NOT_ALLOWED', 'E_HEADER_USE_API_FIELD', 'E_HEADER_VALUE_INVALID', 'E_HEADER_VALUE_TOO_LONG', 'E_HEADER_NAME_INVALID',
  'E_HEADERS_TOO_LARGE', 'E_HEADERS_TOO_MANY',
]);

/** "<code>: <message>" for last_error, and whether the error is final. Email Service errors carry a `code`. */
export function describeSendError(e: unknown): { error: string; permanent: boolean } {
  const code = e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : null;
  const message = e instanceof Error ? e.message : String(e);
  return { error: code ? `${code}: ${message}` : e instanceof Error ? `${e.name}: ${message}` : message, permanent: !!code && PERMANENT_SEND_ERROR_CODES.has(code) };
}
