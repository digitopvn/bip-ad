#!/usr/bin/env bash
# Set up PayPal for one environment in one go:
#   1. read the REST app's Client ID and Secret with hidden prompts,
#   2. check them against PayPal and find or create the webhook for this environment,
#   3. store PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_WEBHOOK_ID in the AgentKit vault
#      and on the worker.
# Values never touch disk, argv or shell history. Safe to re-run: an existing webhook is reused.
#
# Usage: scripts/setup-paypal.sh staging|production
#   or:  PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… scripts/setup-paypal.sh staging   (no prompts)
#   staging:    a Sandbox app from developer.paypal.com (Apps & Credentials, Sandbox)
#   production: a Live app of the PayPal Business account (Apps & Credentials, Live)
set -euo pipefail

ENV_NAME="${1:-}"
case "$ENV_NAME" in
  staging)    WRANGLER_ENV="";           HOST="bip-ad.digitop-vn.workers.dev"; API="https://api-m.sandbox.paypal.com"; APP_KIND="Sandbox"; MODE="sandbox" ;;
  production) WRANGLER_ENV="production"; HOST="bip.ad";                         API="https://api-m.paypal.com";         APP_KIND="Live";    MODE="live" ;;
  *) echo "Usage: $0 staging|production" >&2; exit 1 ;;
esac
WEBHOOK_URL="https://$HOST/api/webhooks/paypal"
# The events src/payments/process.ts handles; PENDING and DENIED are recorded and ignored.
EVENTS='[{"name":"PAYMENT.CAPTURE.COMPLETED"},{"name":"PAYMENT.CAPTURE.REFUNDED"},{"name":"PAYMENT.CAPTURE.REVERSED"},{"name":"PAYMENT.CAPTURE.DENIED"},{"name":"PAYMENT.CAPTURE.PENDING"}]'

# Non-interactive use: pass both values in the environment (for example from the vault), never as arguments.
CLIENT_ID="${PAYPAL_CLIENT_ID:-}"
CLIENT_SECRET="${PAYPAL_CLIENT_SECRET:-}"
unset PAYPAL_CLIENT_ID PAYPAL_CLIENT_SECRET
if { [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; } && [ ! -t 0 ]; then
  echo "This script reads values with hidden prompts and needs an interactive terminal, or PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in the environment." >&2
  exit 1
fi
cd "$(dirname "$0")/.."
# shellcheck source=scripts/store-worker-secret.sh
source scripts/store-worker-secret.sh

echo "PayPal setup for $ENV_NAME ($API, webhook $WEBHOOK_URL)."
[ -n "$CLIENT_ID" ] || { read -r -s -p "PAYPAL_CLIENT_ID: " CLIENT_ID; echo; }
[ -n "$CLIENT_SECRET" ] || { read -r -s -p "PAYPAL_CLIENT_SECRET: " CLIENT_SECRET; echo; }
[ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ] || { echo "Both values are required." >&2; exit 1; }

# curl reads credentials and the bearer token from a config on stdin, so they never reach argv.
TOKEN="$(curl -sS --fail-with-body -K - "$API/v1/oauth2/token" -d grant_type=client_credentials <<<"user = \"$CLIENT_ID:$CLIENT_SECRET\"" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')" \
  || { echo "PayPal rejected the credentials (is this a $APP_KIND app?)." >&2; exit 1; }
echo "  credentials: accepted by PayPal"

paypal() { # paypal METHOD PATH [JSON_BODY]
  local args=(-sS --fail-with-body -K - -X "$1" "$API$2" -H 'content-type: application/json')
  [ $# -ge 3 ] && args+=(-d "$3")
  curl "${args[@]}" <<<"header = \"authorization: Bearer $TOKEN\""
}

WEBHOOK_ID="$(paypal GET /v1/notifications/webhooks | python3 -c '
import json, sys
url = sys.argv[1]
print(next((w["id"] for w in json.load(sys.stdin).get("webhooks", []) if w.get("url") == url), ""))' "$WEBHOOK_URL")"
if [ -n "$WEBHOOK_ID" ]; then
  paypal PATCH "/v1/notifications/webhooks/$WEBHOOK_ID" "[{\"op\":\"replace\",\"path\":\"/event_types\",\"value\":$EVENTS}]" >/dev/null
  echo "  webhook: reused $WEBHOOK_ID (event types refreshed)"
else
  WEBHOOK_ID="$(paypal POST /v1/notifications/webhooks "{\"url\":\"$WEBHOOK_URL\",\"event_types\":$EVENTS}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
  echo "  webhook: created $WEBHOOK_ID"
fi
unset TOKEN

store_worker_secret PAYPAL_CLIENT_ID "$CLIENT_ID"
store_worker_secret PAYPAL_CLIENT_SECRET "$CLIENT_SECRET"
store_worker_secret PAYPAL_WEBHOOK_ID "$WEBHOOK_ID"
unset CLIENT_ID CLIENT_SECRET

ak secrets sync now -q >/dev/null 2>&1 && echo "Vault synced." || echo "Vault sync skipped (run: ak secrets sync now)."
echo "Done. PayPal is offered at checkout once the $ENV_NAME worker runs with PAYMENT_MODE=$MODE."
