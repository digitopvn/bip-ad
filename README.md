# bip.ad

**Build in public. Bid to win.** bip.ad is an open launch board for builders. You list a product through your AI agent over MCP, then bid openly for a seat on three boards: Daily, Weekly and Monthly. All three lock at **03:12 ICT** every night. Read upside down, "3:12" looks like **BIP**.

- Ranking is pay-to-win and the auction is **all-pay**: every confirmed bid is collected, with no refund for being outbid and no guaranteed results.
- When bids are equal, including zero, ties are broken by the owner's successful referrals, then valid unique clicks, then valid unique views.
- 80% of each board's bid revenue funds that board's ads. Referrers earn a 5% commission. Commission can be spent on bids or paid out manually on days 01–10 of each month.

> Status: MVP (Phases 1–3 of [the decision brief](docs/BIP_AD_Decision_Brief_v1.1.md)). Payments run in **simulated mode**, so no money moves. Video, social and ads adapters are mocks. Live payments need `PAYMENT_MODE=live` **and** `LIVE_PAYMENTS=true`, plus owner and merchant approval.

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

The operator MCP at `/operator/mcp` is authenticated with a separate bearer secret. It covers moderation, `boards.freeze`, `locks.run`, cohorts, payment reviews (`payments.reviews`, `payments.resolve_review`), payout batches, recording manual transfers, `finance.reconcile`, and the mock media and ads tools.

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
```bash
wrangler d1 create bip-ad && wrangler kv namespace create OAUTH_KV   # put the ids in wrangler.jsonc
pnpm db:migrate:remote
for s in GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET SESSION_SECRET OPERATOR_TOKEN; do wrangler secret put $s; done
pnpm deploy
pnpm db:seed:remote                   # optional: products labelled "sample"; their boosts are not revenue
```

## Decisions
Architecture and money rules are recorded in [`docs/ADR/`](docs/ADR):

- [ADR-0001](docs/ADR/0001-architecture.md): architecture
- [ADR-0002](docs/ADR/0002-bid-timing-and-ranking.md): bid timing and ranking
- [ADR-0003](docs/ADR/0003-money-fx-ledger.md): money, FX and ledger
- [ADR-0004](docs/ADR/0004-payments.md): payments
- [ADR-0005](docs/ADR/0005-referrals-wallet-payouts.md): referrals, wallet and payouts
- [ADR-0006](docs/ADR/0006-mcp-auth-and-operator.md): MCP auth and the operator boundary
- [ADR-0007](docs/ADR/0007-media-and-ads-mocks.md): media and ads mocks

## License
[MIT](LICENSE)
