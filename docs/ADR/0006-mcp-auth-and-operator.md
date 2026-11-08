# ADR-0006: MCP authentication and the operator boundary

Status: accepted

## User MCP (`/mcp`)
- OAuth 2.1 via `workers-oauth-provider` protects the endpoint:
  - dynamic client registration at `/register`;
  - consent at `/authorize`;
  - identity from GitHub or Google.
- The grant props carry only `userId`.
- Tools never take a user id argument. A resource owned by someone else returns 403.
- Tool names use the dotted names from the brief (`products.create`, `boosts.quote`, ...). The MCP spec allows dots in tool names.

## Operator MCP (`/operator/mcp`)
- Uses a separate bearer secret, `OPERATOR_TOKEN`, of at least 32 characters. User tokens never work there.
- Operator tools cannot edit balances. Every money movement goes through audited domain functions and writes to `decision_logs`.

## Web
The web has no route that creates or edits a product. Only MCP changes products (acceptance scenario A02).
