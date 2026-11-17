#!/usr/bin/env bash
# Prints a 10 minute App Store Connect API token (ES256 JWT) for the given key.
# Usage: scripts/asc-token.sh KEY_FILE KEY_ID ISSUER_ID
# Callers must never echo the token into a log.
set -euo pipefail
key="$1" kid="$2" issuer="$3"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
now=$(date +%s)
header=$(printf '{"alg":"ES256","kid":"%s","typ":"JWT"}' "$kid" | b64url)
payload=$(printf '{"iss":"%s","iat":%d,"exp":%d,"aud":"appstoreconnect-v1"}' "$issuer" "$now" "$((now + 600))" | b64url)
# openssl signs in DER; a JWT needs the raw 64 byte r||s form.
signature=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$key" -binary | python3 -c '
import sys
der = sys.stdin.buffer.read()
i = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)
parts = []
for _ in range(2):
    assert der[i] == 2
    n = der[i + 1]
    parts.append(der[i + 2:i + 2 + n].lstrip(b"\0").rjust(32, b"\0"))
    i += 2 + n
sys.stdout.buffer.write(parts[0] + parts[1])' | b64url)
printf '%s.%s.%s' "$header" "$payload" "$signature"
