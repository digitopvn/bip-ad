# ADR-0001: Modular monolith on Cloudflare Workers + D1

Status: accepted (2026-11-08)

## Context
The repo is greenfield. The brief asks for TypeScript, a relational store with transactions and unique constraints, raw-body webhook verification, a durable scheduler and server-side rendering, without microservices.

## Decision
- One Worker (`bip-ad`). Hono serves the web routes, `@cloudflare/workers-oauth-provider` handles MCP OAuth, and `@modelcontextprotocol/sdk` serves `/mcp` and `/operator/mcp` over stateless Streamable HTTP.
- D1 (SQLite) holds everything, including the ledger. KV holds OAuth grants, web sessions and short-lived OAuth state.
- Two Cron Triggers: the 03:12 ICT lock (`12 20 * * *`) and an hourly run (`40 * * * *`). The hourly run vests commissions, expires quotes and catches up a missed lock. Both are idempotent.
- D1 has no interactive transactions. Every multi-row change is one `db.batch()`, which is atomic. Correctness under retries and races comes from UNIQUE and CHECK constraints that abort the whole batch.
- Domain events are written to `outbox_events` in the same batch. Consumers track their own progress and never update `outbox_events`, so its `status` column is unused. The only consumer today is the email projector ([ADR-0009](0009-transactional-email.md)); `operator.health` reports its backlog as `email_projection_backlog`.

## Consequences
There is one deploy and no queue infrastructure to run. Live ranking updates use 30-second polling of `/api/boards/{board}`, not SSE or WebSocket.
