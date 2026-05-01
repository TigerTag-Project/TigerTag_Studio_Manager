#!/usr/bin/env bash
# Generate the 6 GitHub Secret values needed by the Build & Release workflow.
# Outputs them in a copy-paste-friendly format. Does NOT push anything.
#
# Prerequisites:
#   1. .env populated with APPLE_API_KEY (path to .p8), APPLE_API_KEY_ID, APPLE_API_ISSUER, APPLE_TEAM_ID
#   2. A .p12 export of your Developer ID Application certificate at the path passed as $1
#
# Usage:
#   ./scripts/print-github-secrets.sh ~/Documents/AppleKeys/DeveloperID_3DFrance.p12

set -e

cd "$(dirname "$0")/.."

# --- Load .env ---
if [ ! -f .env ]; then
  echo "ERROR: .env not found in $(pwd)"
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

# --- Validate .env ---
for var in APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_TEAM_ID; do
  if [ -z "${!var}" ]; then
    echo "ERROR: \$$var not set in .env"
    exit 1
  fi
done

if [ ! -f "$APPLE_API_KEY" ]; then
  echo "ERROR: .p8 not found at $APPLE_API_KEY"
  exit 1
fi

# --- Validate .p12 ---
P12_PATH="${1:-}"
if [ -z "$P12_PATH" ]; then
  echo "Usage: $0 <path-to-.p12>"
  echo
  echo "First, export your Developer ID Application certificate from Keychain Access:"
  echo "  1. Open Keychain Access (Spotlight: 'Keychain')"
  echo "  2. Find 'Developer ID Application: 3D France' (login keychain → My Certificates)"
  echo "  3. Right-click → Export → Save As 'DeveloperID_3DFrance.p12' to ~/Documents/AppleKeys/"
  echo "  4. Set a strong password — REMEMBER IT (you'll paste it as MACOS_CERTIFICATE_PASSWORD)"
  echo
  echo "Then re-run this script with the .p12 path:"
  echo "  $0 ~/Documents/AppleKeys/DeveloperID_3DFrance.p12"
  exit 1
fi

if [ ! -f "$P12_PATH" ]; then
  echo "ERROR: .p12 not found at $P12_PATH"
  exit 1
fi

# --- Compute base64 values ---
P12_BASE64=$(base64 -i "$P12_PATH" | tr -d '\n')
P8_BASE64=$(base64 -i "$APPLE_API_KEY" | tr -d '\n')

cat <<EOF

================================================================================
  GitHub Secrets to paste into:
  https://github.com/TigerTag-Project/TigerTag_Studio_Manager/settings/secrets/actions
================================================================================

(The 6 secrets below — paste each one as a NEW REPOSITORY SECRET)

--------------------------------------------------------------------------------
  1. Name:  MACOS_CERTIFICATE
     Value: (base64 of your .p12 — copy the LONG STRING below)

$P12_BASE64

--------------------------------------------------------------------------------
  2. Name:  MACOS_CERTIFICATE_PASSWORD
     Value: (the password you set when exporting the .p12 from Keychain Access)
            ↑ You set this manually. Type it directly into the GitHub UI.

--------------------------------------------------------------------------------
  3. Name:  APPLE_API_KEY_BASE64
     Value: (base64 of the .p8 file — copy the string below)

$P8_BASE64

--------------------------------------------------------------------------------
  4. Name:  APPLE_API_KEY_ID
     Value: $APPLE_API_KEY_ID

--------------------------------------------------------------------------------
  5. Name:  APPLE_API_ISSUER
     Value: $APPLE_API_ISSUER

--------------------------------------------------------------------------------
  6. Name:  APPLE_TEAM_ID
     Value: $APPLE_TEAM_ID

================================================================================
  After pasting all 6 secrets, push a tag to trigger a release:
    git tag v1.4.2
    git push origin v1.4.2
================================================================================
EOF
