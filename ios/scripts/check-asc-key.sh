#!/usr/bin/env bash
# Proves the App Store Connect key works before a Mac runner is started.
# Usage: scripts/check-asc-key.sh KEY_FILE KEY_ID ISSUER_ID [URL]
# Prints only Apple's HTTP status, never the key or the token.
set -euo pipefail
key="$1" kid="$2" issuer="$3" url="${4:-https://api.appstoreconnect.apple.com/v1/apps?limit=1}"

token=$("$(dirname "$0")/asc-token.sh" "$key" "$kid" "$issuer")
status=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "$url")
echo "App Store Connect answered $status for key $kid"
[ "$status" = "200" ]
