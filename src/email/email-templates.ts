// Placeholder entry point; the template sub-session replaces the body with the real templates.
import type { EmailMessageData, EmailRenderContext, RenderedEmail } from './email-message-types';

/** Render one transactional email. Pure: no I/O, deterministic for the same input. */
export function renderEmail(data: EmailMessageData, ctx: EmailRenderContext): RenderedEmail {
  const subject = `${ctx.subjectPrefix}bip.ad: ${data.kind}`;
  return { subject, html: `<p>${data.kind}</p>`, text: data.kind };
}
