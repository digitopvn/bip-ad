# ADR-0008: AI moderation scores every submission and edit

Status: accepted. Supersedes the `AUTO_APPROVE_PRODUCTS` flag from ADR-0006.

## Context
Products are listed by agents over MCP, so the listing text, page blocks and landing page are untrusted input. They can carry scams, phishing, restricted offers, or prompt injection aimed at the operator's agent. Manual review of every change does not scale. A single LLM pass is itself an injection target.

## Decision
`MODERATION_MODE` replaces `AUTO_APPROVE_PRODUCTS`:

| Mode | Behaviour |
|---|---|
| `screen` | The regex screen alone auto-approves inline. Used by tests and local development without AI credentials. |
| `manual` | AI scores every change. The operator approves everything. |
| `ai` | AI scores every change and auto-approves low-risk ones. Everything else waits for the operator. Used by staging and production. |

An unset mode means `manual` (fail closed).

Every `products.submit`, `products.update`, `pages.set_blocks` and `pages.publish` on a product that awaits moderation is scored again. Each score is pinned to the product version it scored ([`src/moderation/ai-moderation-pipeline.ts`](../../src/moderation/ai-moderation-pipeline.ts)):

1. **Stage 0: regex.** A hit skips the models and waits for the operator.
2. **Stage 1: fast decision model, inline in the tool call.** It answers typed questions: injection, scam, category and risk. A clear injection, scam or restricted category stops here, and that content never reaches the LLM.
3. **Stage 2: async (`waitUntil`).** The worker fetches the landing page through an SSRF-guarded fetcher (https only, no IP literals or internal or own hosts, manual redirects ≤3 re-checked per hop, 5 s, 512 KB, HTML only). It then asks the full decision model and the evidence LLM in parallel.
4. **Policy in code** ([`moderation-questions-and-policy.ts`](../../src/moderation/moderation-questions-and-policy.ts)). Approval needs every signal at or below `MODERATION_APPROVE_MAX_RISK`, a readable landing page that matches the listing, and no high-severity red flag from the LLM. The LLM can veto but never approve.
5. **Approval** goes through `moderateProduct` with the scored version, the same guard the operator uses. A change made during scoring is never published.

The hourly cron retries AI errors up to 3 attempts per version, then hands the product to the operator. AI errors never approve. `products.pending` shows the scores of the exact version under review. `moderation.rescore` re-runs both stages for the current version.

## Providers
Providers sit behind two provider-neutral clients, so switching provider or model is configuration only:

- Decision model ([`decision-model-client.ts`](../../src/moderation/decision-model-client.ts)): `MODERATION_DECISION_PROVIDER` is `cloudflare` (Clef on Workers AI), `typesafe` (Jev) or `openrouter` (Jev). `MODERATION_DECISION_MODEL_FAST` and `MODERATION_DECISION_MODEL` name the models. Both stages use `clef`. A live benchmark preferred it over `clef-omni` for its injection margin ([report](../../plans/reports/researcher-261109-1153-workers-ai-decision-model-choice.md)). `clairic` is an extraction model and cannot answer these questions.
- Evidence LLM ([`chat-model-client.ts`](../../src/moderation/chat-model-client.ts)): any OpenAI-compatible chat API. `MODERATION_LLM_PROVIDER` is `cloudflare` (Workers AI) or `openrouter`; `MODERATION_LLM_MODEL` names the model.

Workers AI is called over REST with its own account (`AI_CLOUDFLARE_ACCOUNT_ID`, `AI_CLOUDFLARE_API_TOKEN`), not through an `AI` binding, so its usage and billing stay separate from the hosting account. `TYPESAFE_API_KEY` and `OPENROUTER_API_KEY` are only needed for those providers. When the active provider has no credentials, every change waits for the operator.

## Fail-closed rules
- The AI approves only from `pending_review` or `published`. Every operator decision (approve, reject or suspend) moves the product version, so a score taken before the decision can never be applied after it. Suspended, rejected and draft products are never scored, and suspended products cannot get new page drafts.
- Every submission moves the version, so a resubmission is scored as its own version.
- A decision-model answer of the wrong type or out of range is an AI error, not a zero risk. LLM evidence without a `red_flags` array counts as missing. An unknown severity counts as `high`.
- The async stage has a 25 s budget for its external calls, inside the `waitUntil` window. A run that dies on its last attempt is marked failed by the next sweep and handed to the operator.
- An AI failure after a change was committed never turns the MCP tool call into an error. The agent is told `needs_operator` with `AI_ERROR`. A provider name typo fails at startup.

## Consequences
- The decision model itself reads the untrusted listing, so it is an injection target too. Its answers are treated as signals only. It cannot call tools, and approval needs every signal below the bar, a readable landing page and an LLM pass. An injection that pushes the model towards "safe" still has to fool the full model, the LLM and the regex screen at the same version, and an operator can still suspend the product.
- Scores live in `moderation_scores`, one row per stage per product version, with the raw answers so the policy can be re-evaluated. Decisions are logged as `system:ai-moderation` under policy `mod-v2-ai`.
- Cloaked landing pages and JS-only landing pages can pass the page checks. Images are not analysed yet.
- There is no auto-reject. A deferred product waits for the operator, and the builder's agent is told `needs_operator`.
