# Choosing the Workers AI decision model for moderation

Date: 2026-11-09. Candidates: `clef`, `clef-omni`, `clairic` (Workers AI, all ZDR, vision).

## Recommendation
Use `clef` for both stages (`MODERATION_DECISION_MODEL_FAST=clef`, `MODERATION_DECISION_MODEL=clef`). Switching to `clef-omni` later is a config change.

## Why
- `clairic` is an extraction model. It takes `fields` (text, number, date, list, estimate), not `noul`/`choice`/`score` questions, so it cannot answer the moderation questions. It is not a candidate.
- `clef` gives much stronger and more consistent injection signals. That is the stage-1 gate that keeps injected content away from the LLM, so it is what matters most here.
- The cost difference is negligible. One scored change uses about 0.8k tokens at stage 1 and a few thousand at stage 2, so roughly $0.001 per change on `clef` against $0.0007 on `clef-omni`.
- The latency difference is irrelevant. Stage 1 runs inline and either model finishes well under 1 s.

## Live benchmark
15 labelled listings, each run twice per model through the pipeline's own `FAST_QUESTIONS` and policy. Six were legitimate, including the hard negatives (crypto wallet, VPN, a Vietnamese SaaS). Nine were bad: a crypto doubler, a wallet-drainer airdrop, trading signals, a casino, a direct injection, a subtle "note for automated reviewers" injection, a Vietnamese injection, a Vietnamese task scam and a Google impersonation. The script and raw output are in the session scratchpad. The results:

| | clef | clef-omni |
|---|---|---|
| Fast-stage verdicts matching the labels | 15/15 | 15/15 |
| Verdicts matching the labels at the strict 0.3 approve bar | 15/15 | 14/15 (the VPN, a false defer) |
| Injection probability on the 3 injection samples | 0.98 / 0.98 / 0.98 | 0.91 / 0.90 / 0.86 |
| Risk score on the injection samples (0–4) | 3.0 / 2.5 / 3.2 | 0.8 / 0.3 / 1.3 |
| Same scores across 2 runs | 15/15 | 15/15 |
| Latency p50 / p90 | 465 / 636 ms | 262 / 315 ms |
| Input tokens per call | ~776 | ~771 |
| Price per million input tokens (no charge for output) | $0.24 | $0.15 |
| Architecture | 27B dense | 30B MoE (3B active), adds audio and video |

`clef-omni` flags injection but rates injected listings as low risk, so its margin above the 0.5 stop threshold is thinner. `clef` treats injection as both an injection and a risk.

## Findings that affect the code
- The API rejects `clef-flash` ("Unsupported model 'clef-flash'. Use 'clef'"), even though the docs still list it. The fast-stage default is now `clef`.
- The response shapes match the client: `result.answers`. A `score` answer also carries a `legend`. `usage.output_tokens` is 0.
- The DeepSeek v4.1 Flash OpenAI-compatible endpoint accepts `response_format: json_object` and `reasoning_effort: none`, and returns valid JSON.

## Unresolved questions
- 15 samples is a small set, so treat the result as directional. Revisit `clef-omni` if volume grows enough for cost to matter, using real `moderation_scores` data.
- Images are not scored yet. Both Clef models accept embedded images, so product images could be added later.
