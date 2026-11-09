# bip.ad

**Build in public. Bid to win.** bip.ad is an open launch board for builders. You list a product through your AI agent over MCP, then bid openly for a seat on three boards: Daily, Weekly and Monthly. All three lock at **03:12 ICT** every night. Read upside down, "3:12" looks like **BIP**.

- Ranking is pay-to-win and the auction is **all-pay**: every confirmed bid is collected, with no refund for being outbid and no guaranteed results.
- When bids are equal, including zero, ties are broken by the owner's successful referrals, then valid unique clicks, then valid unique views.
- 80% of each board's bid revenue funds that board's ads. Referrers earn a 5% commission. Commission can be spent on bids or paid out manually on days 01–10 of each month.

> Status: MVP (Phases 1–3 of [the decision brief](docs/BIP_AD_Decision_Brief_v1.1.md)). Payments run in **simulated mode**, so no money moves. Video, social and ads adapters are mocks. Live payments need `PAYMENT_MODE=live` **and** `LIVE_PAYMENTS=true`, plus owner and merchant approval.

Policies are public at `/terms`, `/privacy` and `/refunds` (linked from the footer and checkout; owner legal review pending before live payments).

## Stack
Cloudflare Workers, Hono, D1 (data and double-entry ledger), KV (OAuth and sessions), Cron Triggers, `@cloudflare/workers-oauth-provider`, and `@modelcontextprotocol/sdk` (Streamable HTTP). Tests run on Vitest with `@cloudflare/vitest-pool-workers`.

## Connect your agent
Add the MCP server `https://<your-host>/mcp` to Claude, ChatGPT or any MCP client. It signs you in with GitHub or Google over OAuth.

| Tool | What it does |
|---|---|
| `products.create` / `products.update` / `products.submit` / `products.get` / `products.list` | Manage your products. Only MCP can create or edit them; the website has no create form. |
| `pages.set_blocks` / `pages.preview` / `pages.publish` | Build a versioned product page from widgets: hero, gallery, video, feature_grid, rich_text, call_to_action, pricing, testimonials, faq, founder_note, links, metrics. |
| `boards.get` | Live board with the next cutoff. |
| `boosts.quote` / `boosts.checkout` / `boosts.status` | Quote a bid increment, get a checkout URL that the human pays, and track it. |
| `referrals.get_link` / `referrals.stats` | Your referral link and its results. |
| `wallet.balance` / `wallet.apply_to_bid` | Commission wallet balances, and spending them on a bid. |
| `payouts.request` / `payouts.status` | Request a manual payout of available commission. |
| `analytics.product` | Valid views, clicks and standings for a product. |

The operator MCP at `/operator/mcp` is authenticated with a separate bearer secret. It covers moderation (`products.pending` with AI scores, `products.moderate`, `moderation.rescore`), `emails.list`, `boards.freeze`, `locks.run`, cohorts, payment reviews (`payments.reviews`, `payments.resolve_review`), payout batches, recording manual transfers, `finance.reconcile`, and the mock media and ads tools.

## Email
Users get English transactional email through Cloudflare Email Service ([ADR-0009](docs/ADR/0009-transactional-email.md)): a welcome, product decisions, bid receipts and reversals, the nightly 03:12 lock results, available commissions and paid payouts. The emails are projected from the domain events in `outbox_events` into `email_outbox`. They are sent right after the change, and a dedicated cron sends anything left over and retries failures every 15 minutes. Users switch the Products, Boards and Referrals groups off in `/account` or with the one-click unsubscribe link. Receipts, reversals, payouts and the welcome are always sent. The operator inspects delivery with `emails.list` on `/operator/mcp`.

Each environment needs the `EMAIL` `send_email` binding and `EMAIL_FROM` (both in `wrangler.jsonc`), and the `bip.ad` zone onboarded under **Compute → Email Service → Email Sending**. Staging sends real email with a `[staging]` subject prefix.

## Develop
```bash
pnpm install
cp .dev.vars.example .dev.vars        # fill in OAuth apps, SESSION_SECRET, OPERATOR_TOKEN
pnpm db:migrate:local
pnpm dev                              # http://localhost:8787
pnpm typecheck && pnpm test
```

Set the OAuth callback URLs to `https://<host>/auth/github/callback` and `https://<host>/auth/google/callback`.

## Deploy
Two environments live in `wrangler.jsonc`:

| Environment | Branch | Worker | URL | Config |
|---|---|---|---|---|
| Staging | `dev` | `bip-ad` | https://bip-ad.digitop-vn.workers.dev | top level (`--env=""`) |
| Production | `main` | `bip-ad-production` | https://bip.ad, https://www.bip.ad | `env.production` (`--env production`) |

Both environments run AI moderation (`MODERATION_MODE=ai`, [ADR-0008](docs/ADR/0008-ai-moderation.md)). Every submission and edit is scored: the regex screen and a fast decision model (Clef-flash) run inline, then the landing page is fetched and scored by Clef together with an evidence LLM (DeepSeek V4.1 Flash). Low-risk changes publish automatically. Everything else waits for the operator's agent over `/operator/mcp` (`products.pending` shows the scores, then `products.moderate`). Workers AI runs on its own Cloudflare account, so each environment needs the secrets `AI_CLOUDFLARE_ACCOUNT_ID` and `AI_CLOUDFLARE_API_TOKEN`. Without them, every change waits for the operator.

Each environment has its own D1 database, KV namespace and secrets. CI (`.github/workflows/ci.yml`) runs typecheck and tests on every push and PR. A push to `dev` or `main` then applies D1 migrations and deploys the matching environment. The repository needs the GitHub secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts, D1, Workers KV and Workers Routes edit, plus Zone read for `bip.ad`) and `CLOUDFLARE_ACCOUNT_ID`.

One-time setup for a new environment:
```bash
wrangler d1 create bip-ad-production && wrangler kv namespace create bip-ad-oauth-production   # put the ids in env.production
pnpm db:migrate:production
for s in SESSION_SECRET OPERATOR_TOKEN; do wrangler secret put $s --env production; done
scripts/set-worker-secrets.sh production   # hidden prompts for GitHub/Google OAuth; stores them in `ak secrets` and on the worker
scripts/set-worker-secrets.sh production AI_CLOUDFLARE_ACCOUNT_ID AI_CLOUDFLARE_API_TOKEN   # Workers AI account for moderation
pnpm deploy:production
```

Manual deploys: `pnpm deploy:staging` / `pnpm deploy:production`, with `pnpm db:migrate:remote` / `pnpm db:migrate:production` first. `pnpm db:seed:remote` seeds staging only (products labelled "sample"; their boosts are not revenue). Do not seed production.

## Decisions
Architecture and money rules are recorded in [`docs/ADR/`](docs/ADR):

- [ADR-0001](docs/ADR/0001-architecture.md): architecture
- [ADR-0002](docs/ADR/0002-bid-timing-and-ranking.md): bid timing and ranking
- [ADR-0003](docs/ADR/0003-money-fx-ledger.md): money, FX and ledger
- [ADR-0004](docs/ADR/0004-payments.md): payments
- [ADR-0005](docs/ADR/0005-referrals-wallet-payouts.md): referrals, wallet and payouts
- [ADR-0006](docs/ADR/0006-mcp-auth-and-operator.md): MCP auth and the operator boundary
- [ADR-0007](docs/ADR/0007-media-and-ads-mocks.md): media and ads mocks
- [ADR-0008](docs/ADR/0008-ai-moderation.md): AI moderation of submissions and edits
- [ADR-0009](docs/ADR/0009-transactional-email.md): transactional email through Cloudflare Email Service

## License
[MIT](LICENSE)
