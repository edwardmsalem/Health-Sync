#!/bin/bash
# Archive + upload Health Sync (iOS) to TestFlight.
# Usage:  bash build-testflight.sh
#
# Same pattern as ~/Desktop/GitHub/SalemTriage/build-testflight.sh: signing is
# done with the App Store Connect API key shared across repos on this machine.
# Expects ~/.appstoreconnect/asc.env to export ASC_KEY_ID and ASC_ISSUER_ID,
# and the matching .p8 at ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8.
# With -allowProvisioningUpdates + the API key, xcodebuild fetches the
# distribution profile/cert automatically — no Xcode account sign-in needed.
#
# Unlike SalemTriage this is an Expo app, so the native ios/ project is
# generated (and gitignored) rather than committed: prebuild runs first.
set -e

cd "$(dirname "$0")"

if [ ! -f "apps/mobile/app.json" ]; then
  echo "ERROR: apps/mobile/app.json not found."
  echo "This script must live in the repo root. Current dir: $(pwd)"
  exit 1
fi

# Load App Store Connect credentials. Required.
ASC_ENV="$HOME/.appstoreconnect/asc.env"
if [ ! -f "$ASC_ENV" ]; then
  echo "ERROR: $ASC_ENV not found."
  echo "Expected to export ASC_KEY_ID and ASC_ISSUER_ID."
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ASC_ENV"
set +a

if [ -z "${ASC_KEY_ID:-}" ] || [ -z "${ASC_ISSUER_ID:-}" ]; then
  echo "ERROR: ASC_KEY_ID and/or ASC_ISSUER_ID not set in $ASC_ENV."
  exit 1
fi

ASC_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
if [ ! -f "$ASC_KEY_PATH" ]; then
  echo "ERROR: $ASC_KEY_PATH not found."
  exit 1
fi

AUTH=(
  -allowProvisioningUpdates
  -authenticationKeyPath "$ASC_KEY_PATH"
  -authenticationKeyID "$ASC_KEY_ID"
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"
)

BN=$(date +%Y%m%d%H%M)
REPO_ROOT="$(pwd)"

echo "=========================================="
echo " Health Sync TestFlight build  —  $BN"
echo " ASC key: $ASC_KEY_ID"
echo "=========================================="

echo
echo ">>> Installing dependencies"
npm install --no-audit --no-fund

echo
echo ">>> Generating native iOS project (expo prebuild)"
cd apps/mobile
npx expo prebuild -p ios --clean

echo
echo ">>> iOS archive"
xcodebuild archive -workspace ios/HealthSync.xcworkspace -scheme "HealthSync" \
  -configuration Release -destination "generic/platform=iOS" \
  -archivePath /tmp/HealthSync.xcarchive \
  "${AUTH[@]}" \
  CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=AF6MS7483E \
  CURRENT_PROJECT_VERSION="$BN"

echo
echo ">>> iOS upload to App Store Connect"
xcodebuild -exportArchive -archivePath /tmp/HealthSync.xcarchive \
  -exportOptionsPlist "$REPO_ROOT/CI/ExportOptions-iOS.plist" \
  -exportPath /tmp/HealthSync-export \
  "${AUTH[@]}"

echo
echo "=========================================="
echo " Done — build $BN uploaded to TestFlight"
echo " https://appstoreconnect.apple.com/apps"
echo "=========================================="
