#!/usr/bin/env bash
# Prompt (hidden input) for the GitHub and Google OAuth credentials of one environment,
# store each in the AgentKit vault as BIPAD_<NAME>_<ENV>, then push it to the worker
# with `wrangler secret put`. Values never touch disk, argv or shell history.
#
# Usage: scripts/set-oauth-secrets.sh staging|production
# Callback URLs to register in the OAuth apps:
#   staging:    https://bip-ad.digitop-vn.workers.dev/auth/{github,google}/callback
#   production: https://bip.ad/auth/{github,google}/callback
set -euo pipefail

ENV_NAME="${1:-}"
case "$ENV_NAME" in
  staging)    WRANGLER_ENV="";           HOST="bip-ad.digitop-vn.workers.dev" ;;
  production) WRANGLER_ENV="production"; HOST="bip.ad" ;;
  *) echo "Usage: $0 staging|production" >&2; exit 1 ;;
esac
# Hidden prompts need a real terminal; Claude Code's `!` prefix does not provide one.
if [ ! -t 0 ]; then
  echo "This script reads values with hidden prompts and needs an interactive terminal. Run it in your own terminal." >&2
  exit 1
fi
ENV_UPPER="$(printf '%s' "$ENV_NAME" | tr '[:lower:]' '[:upper:]')"

cd "$(dirname "$0")/.."
echo "Setting OAuth secrets for $ENV_NAME (https://$HOST). Leave a value empty to skip it."

for NAME in GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  read -r -s -p "$NAME: " VALUE; echo
  if [ -z "$VALUE" ]; then echo "  skipped"; continue; fi

  REF="BIPAD_${NAME}_${ENV_UPPER}"
  PROVIDER="$(printf '%s' "$NAME" | cut -d_ -f1 | tr '[:upper:]' '[:lower:]')"
  # Rotate when the ref already exists, otherwise create it with a searchable profile.
  if ak secrets get "$REF" -q >/dev/null 2>&1; then
    printf '%s' "$VALUE" | ak secrets rotate "$REF" --value=- --no-interactive -q
  else
    printf '%s' "$VALUE" | ak secrets set "$REF" --value=- --no-interactive -q \
      --project bip-ad --environment "$ENV_NAME" --provider "$PROVIDER" --usage-host "$HOST" \
      --description "bip.ad $ENV_NAME OAuth $NAME (wrangler secret $NAME)"
  fi
  echo "  vault: $REF stored"

  printf '%s' "$VALUE" | pnpm exec wrangler secret put "$NAME" --env="$WRANGLER_ENV" >/dev/null
  echo "  worker: $NAME uploaded"
  unset VALUE
done

ak secrets sync now -q >/dev/null 2>&1 && echo "Vault synced." || echo "Vault sync skipped (run: ak secrets sync now)."
