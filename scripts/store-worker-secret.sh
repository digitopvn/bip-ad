#!/usr/bin/env bash
# Sourced by the setup scripts. Needs ENV_NAME (staging|production), WRANGLER_ENV and HOST.
# store_worker_secret NAME VALUE: keep VALUE in the AgentKit vault as BIPAD_<NAME>_<ENV>, then push
# it to the worker with `wrangler secret put`. The value goes through stdin only, never argv.

store_worker_secret() {
  local name="$1" value="$2" env_upper ref provider
  env_upper="$(printf '%s' "$ENV_NAME" | tr '[:lower:]' '[:upper:]')"
  ref="BIPAD_${name}_${env_upper}"
  case "$name" in
    AI_CLOUDFLARE_*) provider=cloudflare ;;
    *) provider="$(printf '%s' "$name" | cut -d_ -f1 | tr '[:upper:]' '[:lower:]')" ;;
  esac
  # Rotate when the ref already exists, otherwise create it with a searchable profile.
  if ak secrets get "$ref" -q >/dev/null 2>&1; then
    printf '%s' "$value" | ak secrets rotate "$ref" --value=- --no-interactive -q
  else
    printf '%s' "$value" | ak secrets set "$ref" --value=- --no-interactive -q \
      --project bip-ad --environment "$ENV_NAME" --provider "$provider" --usage-host "$HOST" \
      --description "bip.ad $ENV_NAME worker secret $name"
  fi
  echo "  vault: $ref stored"
  printf '%s' "$value" | pnpm exec wrangler secret put "$name" --env="$WRANGLER_ENV" >/dev/null
  echo "  worker: $name uploaded"
}
