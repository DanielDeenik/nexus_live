#!/usr/bin/env bash
# deploy.sh — Nexus Cloudflare deploy pipeline. Zero hardcoded values.
#
# Usage:
#   ./scripts/deploy.sh [--env development|production] [--skip-migrations] [--skip-secrets]
#
# Reads .env.deploy and apps/api/.dev.vars (gitignored), renders
# wrangler.template.toml, applies D1 migrations, pushes secrets, and deploys
# both the API Worker and the Pages web project.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$ROOT_DIR/apps/api"
WEB_DIR="$ROOT_DIR/apps/web"
MIG_DIR="$ROOT_DIR/migrations"

ENV_NAME="production"
SKIP_MIGRATIONS=0
SKIP_SECRETS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    --skip-migrations) SKIP_MIGRATIONS=1; shift ;;
    --skip-secrets) SKIP_SECRETS=1; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# --- Load deploy config ---
if [[ ! -f "$ROOT_DIR/.env.deploy" ]]; then
  echo "ERROR: $ROOT_DIR/.env.deploy missing. Copy .env.deploy.example and fill in." >&2
  exit 1
fi
set -a; source "$ROOT_DIR/.env.deploy"; set +a

# --- Validate required IDs ---
required_vars=(
  CLOUDFLARE_ACCOUNT_ID WORKER_NAME COMPATIBILITY_DATE
  ZONE_NAME API_DEV_ROUTE API_PROD_ROUTE API_BASE_URL WEB_BASE_URL
  D1_DATABASE_NAME D1_DATABASE_ID D1_PREVIEW_DATABASE_ID
  KV_CACHE_ID KV_CACHE_PREVIEW_ID
  R2_BUCKET_NAME R2_BUCKET_PREVIEW_NAME
  LLM_PROVIDER LLM_MODEL JWT_ALGORITHM JWT_EXPIRY_HOURS
  CRON_DAILY CRON_FEED_REFRESH PAGES_PROJECT_NAME
)
for v in "${required_vars[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    echo "ERROR: $v is empty in .env.deploy" >&2; exit 1
  fi
done

# --- Render wrangler.toml from template ---
echo "==> Rendering wrangler.toml from template"
TEMPLATE="$API_DIR/wrangler.template.toml"
OUTPUT="$API_DIR/wrangler.toml"
if [[ ! -f "$TEMPLATE" ]]; then
  echo "ERROR: $TEMPLATE missing" >&2; exit 1
fi
# envsubst preserves only ${VAR} tokens we want
export $(grep -v '^#' "$ROOT_DIR/.env.deploy" | sed 's/=.*//' | xargs)
envsubst < "$TEMPLATE" > "$OUTPUT"
echo "    -> wrote $OUTPUT"

# --- Apply D1 migrations in order ---
if [[ $SKIP_MIGRATIONS -eq 0 ]]; then
  echo "==> Applying D1 migrations to $D1_DATABASE_NAME ($ENV_NAME)"
  cd "$API_DIR"
  for f in $(ls "$MIG_DIR"/*.sql | sort); do
    echo "    -> $(basename "$f")"
    if [[ "$ENV_NAME" == "production" ]]; then
      npx wrangler d1 execute "$D1_DATABASE_NAME" --remote --file "$f"
    else
      npx wrangler d1 execute "$D1_DATABASE_NAME" --local --file "$f"
    fi
  done
  cd "$ROOT_DIR"
fi

# --- Push secrets from .dev.vars ---
if [[ $SKIP_SECRETS -eq 0 ]]; then
  DEV_VARS="$API_DIR/.dev.vars"
  if [[ ! -f "$DEV_VARS" ]]; then
    echo "WARN: $DEV_VARS missing — skipping secret upload"
  else
    echo "==> Pushing secrets to Worker"
    cd "$API_DIR"
    # Skip blank lines, comments, and public vars (those live in [vars])
    public_vars="API_BASE_URL|WEB_BASE_URL|JWT_ALGORITHM|JWT_EXPIRY_HOURS|LLM_PROVIDER"
    while IFS='=' read -r key val; do
      [[ -z "$key" || "$key" =~ ^# ]] && continue
      [[ "$key" =~ ^($public_vars)$ ]] && continue
      [[ -z "$val" ]] && continue
      echo "    -> wrangler secret put $key"
      printf '%s' "$val" | npx wrangler secret put "$key" --env "$ENV_NAME"
    done < "$DEV_VARS"
    cd "$ROOT_DIR"
  fi
fi

# --- Deploy API Worker ---
echo "==> Deploying API Worker ($ENV_NAME)"
cd "$API_DIR"
npm run build
npx wrangler deploy --env "$ENV_NAME"
cd "$ROOT_DIR"

# --- Deploy Pages (web) ---
echo "==> Building + deploying Pages project: $PAGES_PROJECT_NAME"
cd "$WEB_DIR"
npm run build
npx wrangler pages deploy dist --project-name "$PAGES_PROJECT_NAME"
cd "$ROOT_DIR"

echo "==> Deploy complete."
