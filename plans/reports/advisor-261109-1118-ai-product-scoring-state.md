# advise-state
phase: advise (report delivered)
input: "Tôi muốn thêm 1 lớp chấm điểm và tự động duyệt sản phẩm (mỗi submission và mỗi lần edit đều phải chấm lại) bằng System One model (Decision Model) như Jev (TypeSafe) dùng qua OpenRouter AI API hoặc Clef (Cloudflare) kết hợp với LLM (DeepSeek v4.1 Flash) qua Cloudflare Workers AI hoặc OpenCode Go. Mục đích: hạn chế scam, fraud, security, prompt injection,... (decision model detect prompt injection trước rồi mới tới LLM)."
flags: --agent (orchestrated); report -> plans/reports/advisor-261109-1118-ai-product-scoring.md

## scout-findings
- src/domain/products.ts: `textScreen` (regex: restricted categories + 4 prompt-injection phrases), `moderationScreen` (name+tagline+https check), `pageScreen` (every string in blocks_json). Decision is only 'allow' | 'defer'; `defer` => pending (never auto-reject). Policy tag `MODERATION_POLICY_VERSION` (mod-v1) written to decision_logs via `decisionStatement` with actor `system:auto-moderation`.
- Four entry points re-screen: `updateProduct` (published only -> pending_edit_json), `submitProduct`, `publishPage` (published product -> pending_page_version_id). All synchronous inside the MCP tool call, inside a D1 batch.
- `cfg.autoApprove` (AUTO_APPROVE_PRODUCTS) gates going live: staging true, production false. Operator: `products.pending` (returns version + page that approval would publish), `products.moderate` requires product_version for approve. Every edit bumps `products.version`.
- Outbox events exist (`outboxStatement`: ProductApproved/PageSubmitted...), cron triggers "12 20 * * *" and "40 * * * *" exist; no Workers AI binding, no queue; deps: hono, zod, mcp sdk, oauth provider only.
- No image/screenshot analysis; `image_url` and `website_url` are stored but destination is never fetched.

## external-verification (2026-11-09)
- TypeSafe Jev: direct API POST https://api.typesafe.ai/v1/systemone (state + questions: noul/choice/score/box). Verified via docs.typesafe.ai/api.md.
- Jev via OpenRouter: VERIFIED. `POST https://openrouter.ai/api/v1/systemone` (same shape, model `typesafe/jev-1.14`, alias `~typesafe/jev-latest`), also alpha decisions endpoint. Input-token billing only (~$0.042/M reported third-party). 262k ctx.
- Clef (Cloudflare): VERIFIED. `@cf/cloudflare/clef` on Workers AI via `env.AI.run()`, model "clef" (27B) or "clef-flash" (9B); also clef-omni listed. Jev-compatible shape (state, questions noul/choice/score, 1-64 questions, 65,536 token ctx, images optional). $0.24/M input, output free; clef-flash price not on page. Blog latency: clef median 209ms, clef-flash 38.8ms vs Jev 524ms (vendor numbers). Apache-2.0.
- DeepSeek V4.1 Flash on Workers AI: VERIFIED present in catalog as `deepseek-v4.1-flash-1017` (text+image input, up to 1M ctx). Pricing not confirmed from Cloudflare page (third-party ~ $0.44/$1.32 per M for v4-flash). Also `llama-guard-3-8b` exists on Workers AI.
- OpenCode Go: VERIFIED to exist, includes DeepSeek V4.1 Flash ($0.15-0.30/M in), BUT it is a $10/mo coding-agent subscription; ToS says designed for coding agents, traffic monitored for abuse, requires custom UA + x-opencode-session, DeepSeek needs "Global" region privacy setting. Not suitable as a backend moderation API. Will advise against.

## qa-log
- Q1 prod policy -> A1: auto-approve điểm cao, còn lại chờ operator (recommended)
- Q2 input scope -> A2: tải HTML trang đích server-side, chưa tải ảnh (NOT recommended; addressed as trade-off + SSRF guard)
- Q3 sync/async -> A3: stage 1 inline, stage 2 LLM async (recommended)
- Q4 preview confirmation: SKIPPED by orchestrator instruction; inline Mermaid in report, listed under Needs from you

## reframing-draft
problem: regex screen is trivially bypassed; prod operator must manually review every submission/edit; want AI score to detect scam/fraud/security/prompt-injection and auto-approve safe ones, re-scored on every version.
requirements (draft): R1 score every submit/update/publishPage; R2 stage 1 decision model (injection+risk), stage 2 LLM only when needed; R3 outcome feeds auto-approve/pending/(reject?); R4 logged to decision_logs with policy version; R5 pinned to product version.
open: what the score drives in prod; fetch website_url?; sync vs async; which provider.

## preview
none yet

## next
Done. Report: advisor-261109-1118-ai-product-scoring.md
