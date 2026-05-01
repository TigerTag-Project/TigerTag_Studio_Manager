#!/usr/bin/env bash
# Build, sign with Developer ID, and notarize Tiger Studio Manager for macOS.
# Loads credentials from .env automatically.
set -e

cd "$(dirname "$0")/.."

# Load .env if present
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
  echo "[build] Loaded credentials from .env"
else
  echo "[build] WARN: no .env found — relying on shell env vars"
fi

# Verify required vars
missing=0
for var in APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER; do
  if [ -z "${!var}" ]; then
    echo "ERROR: \$$var is not set"
    missing=1
  fi
done
if [ "$missing" -eq 1 ]; then
  echo
  echo "Copy .env.example to .env and fill in your App Store Connect API Key info."
  exit 1
fi

# Verify the .p8 file is reachable
if [ ! -f "$APPLE_API_KEY" ]; then
  echo "ERROR: APPLE_API_KEY points to '$APPLE_API_KEY' which does not exist."
  exit 1
fi

echo "[build] Using API Key ID: $APPLE_API_KEY_ID"
echo "[build] Issuer ID:        $APPLE_API_ISSUER"
echo "[build] Team ID:          ${APPLE_TEAM_ID:-RT4W5WC9P2}"
echo "[build] Building macOS DMG + ZIP (x64 + arm64), signing with Developer ID, and notarizing…"
echo "[build] This will take several minutes (notarization usually 1–5 min)."
echo

exec npx electron-builder --mac
