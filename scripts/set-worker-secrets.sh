#!/usr/bin/env bash
# Prompt (hidden input) for worker secrets of one environment, store each in the AgentKit vault
# as BIPAD_<NAME>_<ENV>, then push it to the worker with `wrangler secret put`.
# Values never touch disk, argv or shell history.
#
# Usage: scripts/set-worker-secrets.sh staging|production [NAME ...]
#   no NAME: the GitHub and Google OAuth credentials
#   e.g.     scripts/set-worker-secrets.sh production AI_CLOUDFLARE_ACCOUNT_ID AI_CLOUDFLARE_API_TOKEN
# Callback URLs to register in the OAuth apps:
#   staging:    https://bip-ad.digitop.workers.dev/auth/{github,google}/callback
#   production: https://bip.ad/auth/{github,google}/callback
set -euo pipefail

ENV_NAME="${1:-}"
shift || true
NAMES=("$@")
[ ${#NAMES[@]} -eq 0 ] && NAMES=(GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET)
case "$ENV_NAME" in
  staging)    WRANGLER_ENV="";           HOST="bip-ad.digitop.workers.dev" ;;
  production) WRANGLER_ENV="production"; HOST="bip.ad" ;;
  *) echo "Usage: $0 staging|production [NAME ...]" >&2; exit 1 ;;
esac
# Hidden prompts need a real terminal; Claude Code's `!` prefix does not provide one.
if [ ! -t 0 ]; then
  echo "This script reads values with hidden prompts and needs an interactive terminal. Run it in your own terminal." >&2
  exit 1
fi
cd "$(dirname "$0")/.."
# shellcheck source=scripts/store-worker-secret.sh
source scripts/store-worker-secret.sh
echo "Setting ${NAMES[*]} for $ENV_NAME (https://$HOST). Leave a value empty to skip it."

for NAME in "${NAMES[@]}"; do
  read -r -s -p "$NAME: " VALUE; echo
  if [ -z "$VALUE" ]; then echo "  skipped"; continue; fi

  store_worker_secret "$NAME" "$VALUE"
  unset VALUE
done

ak secrets sync now -q >/dev/null 2>&1 && echo "Vault synced." || echo "Vault sync skipped (run: ak secrets sync now)."
