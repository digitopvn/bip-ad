# BIP.AD MVP (Phases 1–3) — plan

Status: in progress · Issue: digitopvn/bip-ad#1 · Source of truth: `docs/BIP_AD_Decision_Brief_v1.1.md`

## Outcome
Cloudflare Worker `bip-ad` (Hono + D1 + KV + Cron) serving the option-D UI, a user MCP behind
OAuth (GitHub/Google), an operator MCP behind a bearer secret, PayPal/SePay adapters in simulated
mode, a double-entry ledger, and the 03:12 ICT snapshot job.

## Phases
| # | Phase | Owner files | Depends |
|---|-------|-------------|---------|
| 1 | Scaffold, schema, config | `wrangler.jsonc`, `migrations/`, `src/env.ts`, `src/lib/` | — |
| 2 | Domain: ranking, ledger, payments, referrals, wallet, payouts, snapshot | `src/domain/` | 1 |
| 3 | Auth + MCP (user, operator) | `src/auth/`, `src/mcp/` | 2 |
| 4 | Web UI from design D | `src/views/`, `public/` (sub-agent) | 1 (view-model types) |
| 5 | Routes, webhooks, cron wiring, seed | `src/routes/`, `src/index.ts`, `seed/` | 2–4 |
| 6 | Tests + CI | `test/`, `.github/workflows/` | 2–5 |
| 7 | Deploy, verify routes, isolated review | — | 6 |

## Acceptance
The Done-means list in issue #1. Key invariants tested: A03, A05, A06, A07, A08–A12, A19–A25, A27–A31, A33.

## Risks
- PayPal/SePay payload shapes coded from docs, not exercised against sandbox (out of scope): ADR-0004.
- D1 has no interactive transactions: atomicity via `db.batch()` + UNIQUE/CHECK constraints.
