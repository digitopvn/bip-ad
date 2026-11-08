# ADR-0006: MCP authentication and the operator boundary

Status: accepted

## User MCP (`/mcp`)
- OAuth 2.1 via `workers-oauth-provider` protects the endpoint:
  - dynamic client registration at `/register`;
  - consent at `/authorize`;
  - identity from GitHub or Google.
- The consent page shows the client name (self-declared unless it has a verified domain), the host that receives the tokens, a warning for loopback redirects, and the requested scopes.
- Approval is an explicit POST. The provider's consent handle is bound to the browser by a cookie and works once, so a link alone cannot approve a client. The upstream `state` is bound the same way (`beginUpstream` / `finishUpstream`).
- The grant props carry only `userId`.
- Tools never take a user id argument. A resource owned by someone else returns 403.
- Tool names use the dotted names from the brief (`products.create`, `boosts.quote`, ...). The MCP spec allows dots in tool names.

## Operator MCP (`/operator/mcp`)
- Uses a separate bearer secret, `OPERATOR_TOKEN`, of at least 32 characters. User tokens never work there.
- Operator tools cannot edit balances. Every money movement goes through audited domain functions and writes to `decision_logs`.

## Moderation of edits
- Edits to a published product, and new page versions, go live only when `AUTO_APPROVE_PRODUCTS=true` and the automated screen passes. Otherwise they wait as `pending_edit_json` / `pending_page_version_id` until the operator approves. `products.pending` lists them with the product version, and approving pending changes requires that version, so the operator approves exactly what they reviewed.
- Rejecting the pending changes of a suspended product keeps it suspended.
- Suspending a product removes it from every snapshot whose media is not final (`removed_from_publication`), with a decision log per snapshot.

## Web
The web has no route that creates or edits a product. Only MCP changes products (acceptance scenario A02).
