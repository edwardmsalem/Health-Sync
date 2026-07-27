#!/usr/bin/env bash
# Generates Cadence.xcodeproj from project.yml and opens it.
#
#   ./bootstrap.sh              # generate
#   ./bootstrap.sh --open       # generate and open in Xcode
#
# The .xcodeproj is intentionally not committed: it is a build artifact of
# project.yml, and checking it in is what makes Xcode projects merge badly.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen not found. Install it with:" >&2
  echo "  brew install xcodegen" >&2
  exit 1
fi

if [[ -z "${DEVELOPMENT_TEAM:-}" ]]; then
  echo "note: DEVELOPMENT_TEAM is unset; signing will need to be set in Xcode."
  echo "      Find your team ID at https://developer.apple.com/account (Membership)."
  echo "      Then: export DEVELOPMENT_TEAM=ABCDE12345"
fi

xcodegen generate
echo "Generated Cadence.xcodeproj"

if [[ "${1:-}" == "--open" ]]; then
  open Cadence.xcodeproj
fi
