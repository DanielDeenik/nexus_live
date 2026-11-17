#!/usr/bin/env bash
# Fills Config/App.xcconfig from environment variables (GitHub secrets in CI).
# Empty backend values are allowed: the app then shows that the backend is not connected.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${IV_BUNDLE_ID:?IV_BUNDLE_ID is required}"
: "${IV_TEAM_ID:?IV_TEAM_ID is required}"
: "${IV_MARKETING_VERSION:?IV_MARKETING_VERSION is required}"
: "${IV_BUILD_NUMBER:?IV_BUILD_NUMBER is required}"

host="${IV_SUPABASE_URL:-}"
host="${host#https://}"

sed -e "s|__IV_BUNDLE_ID__|${IV_BUNDLE_ID}|" \
    -e "s|__IV_TEAM_ID__|${IV_TEAM_ID}|" \
    -e "s|__IV_MARKETING_VERSION__|${IV_MARKETING_VERSION}|" \
    -e "s|__IV_BUILD_NUMBER__|${IV_BUILD_NUMBER}|" \
    -e "s|__IV_SUPABASE_HOST__|${host}|" \
    -e "s|__IV_SUPABASE_ANON_KEY__|${IV_SUPABASE_ANON_KEY:-}|" \
    Config/App.xcconfig.template > Config/App.xcconfig

echo "Wrote Config/App.xcconfig for ${IV_BUNDLE_ID} build ${IV_BUILD_NUMBER}"
