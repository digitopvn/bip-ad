// Provider-neutral client for System One decision models (typed noul / choice / score questions).
// Clef on Workers AI, Jev on TypeSafe and Jev on OpenRouter share the same request and answer
// shape, so switching provider or model is configuration only (MODERATION_DECISION_*).
import type { Env } from '../env';

export type DecisionQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export type DecisionAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence?: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence?: number; probabilities?: Record<string, number> };

export interface DecisionModel {
  provider: string;
  model: string;
  ask(state: unknown, questions: Record<string, DecisionQuestion>): Promise<Record<string, DecisionAnswer>>;
}

export type DecisionProvider = 'cloudflare' | 'typesafe' | 'openrouter';

const TIMEOUT_MS = 15_000;

/** One HTTP endpoint per provider. Workers AI puts the model in the path (clef, clef-omni) as well as in the body. */
function endpoint(env: Env, provider: DecisionProvider, model: string): { url: string; token: string | undefined } {
  switch (provider) {
    case 'cloudflare':
      return {
        url: `https://api.cloudflare.com/client/v4/accounts/${env.AI_CLOUDFLARE_ACCOUNT_ID}/ai/run/${model.startsWith('@cf/') ? model : `@cf/cloudflare/${model}`}`,
        token: env.AI_CLOUDFLARE_ACCOUNT_ID ? env.AI_CLOUDFLARE_API_TOKEN : undefined,
      };
    case 'typesafe':
      return { url: 'https://api.typesafe.ai/v1/systemone', token: env.TYPESAFE_API_KEY };
    case 'openrouter':
      return { url: 'https://openrouter.ai/api/v1/systemone', token: env.OPENROUTER_API_KEY };
  }
}

export function parseDecisionProvider(raw: string | undefined): DecisionProvider {
  const v = (raw ?? 'cloudflare').trim() || 'cloudflare';
  if (v !== 'cloudflare' && v !== 'typesafe' && v !== 'openrouter') throw new Error(`Invalid MODERATION_DECISION_PROVIDER "${v}": use cloudflare, typesafe or openrouter`);
  return v;
}

/** Returns null when the provider has no credentials, so callers fall back to operator review. */
export function decisionModel(env: Env, model: string): DecisionModel | null {
  const provider = parseDecisionProvider(env.MODERATION_DECISION_PROVIDER);
  const { url, token } = endpoint(env, provider, model);
  if (!token) return null;
  return {
    provider,
    model,
    async ask(state, questions) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, state, questions }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`decision model ${provider}/${model} HTTP ${res.status}`);
      const body = (await res.json()) as { result?: { answers?: unknown }; answers?: unknown };
      // Workers AI wraps the model output in { result, success }; TypeSafe and OpenRouter return it bare.
      const answers = (body.result?.answers ?? body.answers) as Record<string, DecisionAnswer> | undefined;
      if (!answers || typeof answers !== 'object') throw new Error(`decision model ${provider}/${model} returned no answers`);
      for (const [id, q] of Object.entries(questions)) {
        const problem = answerProblem(q, answers[id]);
        if (problem) throw new Error(`decision model ${provider}/${model} question ${id}: ${problem}`);
      }
      return answers;
    },
  };
}

const unit = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * Why an answer cannot be trusted, or null. A malformed answer must never read as "no risk",
 * so the caller throws and the job retries or goes to the operator.
 */
export function answerProblem(q: DecisionQuestion, a: DecisionAnswer | undefined): string | null {
  if (!a || typeof a !== 'object') return 'missing answer';
  if (a.type !== q.type) return `expected ${q.type}, got ${String((a as { type?: unknown }).type)}`;
  if (a.type === 'noul') return unit(a.noul) ? null : 'noul out of range';
  if (a.type === 'score') {
    const max = q.type === 'score' ? q.criteria.length - 1 : 0;
    return typeof a.score === 'number' && Number.isFinite(a.score) && a.score >= 0 && a.score <= max ? null : 'score out of range';
  }
  const options = q.type === 'choice' ? Object.keys(q.criteria) : [];
  if (!options.includes(a.choice)) return 'unknown choice';
  if (!a.probabilities || typeof a.probabilities !== 'object' || !Object.values(a.probabilities).every(unit)) return 'invalid probabilities';
  return null;
}

/** Probability that a noul question holds (0 when the answer has another type). */
export const noul = (a: DecisionAnswer | undefined) => (a?.type === 'noul' && Number.isFinite(a.noul) ? a.noul : 0);

/** Probability-weighted score position (0 = first level). */
export const score = (a: DecisionAnswer | undefined) => (a?.type === 'score' && Number.isFinite(a.score) ? a.score : 0);

/** Probability of one choice option. */
export const choiceProbability = (a: DecisionAnswer | undefined, option: string) => (a?.type === 'choice' ? a.probabilities?.[option] ?? (a.choice === option ? 1 : 0) : 0);
