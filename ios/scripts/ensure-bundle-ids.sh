#!/usr/bin/env bash
# Registers any of the given bundle IDs that Apple does not know yet (iOS, no capabilities), so a new
# app extension never fails the TestFlight export. Prints identifiers and HTTP statuses only.
# Usage: scripts/ensure-bundle-ids.sh KEY_FILE KEY_ID ISSUER_ID BUNDLE_ID...
set -euo pipefail
key="$1" kid="$2" issuer="$3"
shift 3
api="https://api.appstoreconnect.apple.com/v1/bundleIds"
token=$("$(dirname "$0")/asc-token.sh" "$key" "$kid" "$issuer")
answer=$(mktemp)
trap 'rm -f "$answer"' EXIT

for id in "$@"; do
  status=$(curl -s --globoff -o "$answer" -w '%{http_code}' -H "Authorization: Bearer $token" \
    "$api?filter[identifier]=$id&limit=200")
  [ "$status" = "200" ] || { echo "::error::Listing bundle ID $id failed with HTTP $status"; exit 1; }
  # The filter can also match longer identifiers, so only an exact match counts.
  if python3 -c 'import json,sys; sys.exit(0 if any(d["attributes"]["identifier"] == sys.argv[2] for d in json.load(open(sys.argv[1]))["data"]) else 1)' "$answer" "$id"; then
    echo "Bundle ID $id is registered"
    continue
  fi
  name="Nexuslive $(printf '%s' "${id##*.}" | tr -cd 'A-Za-z0-9 ')"
  body=$(python3 -c 'import json,sys; print(json.dumps({"data": {"type": "bundleIds", "attributes": {"identifier": sys.argv[1], "name": sys.argv[2], "platform": "IOS"}}}))' "$id" "$name")
  status=$(curl -s -o "$answer" -w '%{http_code}' -X POST -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" -d "$body" "$api")
  [ "$status" = "201" ] || { echo "::error::Registering bundle ID $id failed with HTTP $status"; exit 1; }
  echo "Bundle ID $id registered now"
done
