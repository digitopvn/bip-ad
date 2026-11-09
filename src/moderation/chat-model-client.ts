// Provider-neutral client for the evidence LLM over the OpenAI-compatible chat completions API.
// Workers AI (its own account, over REST) and OpenRouter speak the same protocol, so switching
// provider or model is configuration only (MODERATION_LLM_*).
import type { Env } from '../env';

export interface ChatModel {
  provider: string;
  model: string;
  /** Sends a system + user message pair and parses the reply as a JSON object. */
  json(system: string, user: string): Promise<Record<string, unknown>>;
}

export type ChatProvider = 'cloudflare' | 'openrouter';

const TIMEOUT_MS = 25_000;

export function parseChatProvider(raw: string | undefined): ChatProvider {
  const v = (raw ?? 'cloudflare').trim() || 'cloudflare';
  if (v !== 'cloudflare' && v !== 'openrouter') throw new Error(`Invalid MODERATION_LLM_PROVIDER "${v}": use cloudflare or openrouter`);
  return v;
}

/** Pulls the first JSON object out of a reply, tolerating code fences or stray prose around it. */
export function extractJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('LLM reply contained no JSON object');
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('LLM reply was not a JSON object');
  return parsed as Record<string, unknown>;
}

/** Returns null when the provider has no credentials or no model is configured. */
export function chatModel(env: Env): ChatModel | null {
  const provider = parseChatProvider(env.MODERATION_LLM_PROVIDER);
  const model = (env.MODERATION_LLM_MODEL ?? '').trim();
  const target = provider === 'cloudflare'
    ? { url: `https://api.cloudflare.com/client/v4/accounts/${env.AI_CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`, token: env.AI_CLOUDFLARE_ACCOUNT_ID ? env.AI_CLOUDFLARE_API_TOKEN : undefined }
    : { url: 'https://openrouter.ai/api/v1/chat/completions', token: env.OPENROUTER_API_KEY };
  if (!model || !target.token) return null;
  return {
    provider,
    model,
    async json(system, user) {
      const res = await fetch(target.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature: 0,
          max_completion_tokens: 1200,
          reasoning_effort: 'none',
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`chat model ${provider}/${model} HTTP ${res.status}`);
      const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error(`chat model ${provider}/${model} returned no content`);
      return extractJsonObject(content);
    },
  };
}
