#!/usr/bin/env bash
# Run a verification script against a throwaway profile.
#
# The UI checks drive the real renderer and persist through the real store, so
# they must never run against the user's own launcher data. This builds a
# scratch XDG_DATA_HOME, seeds it, runs the check, and discards it afterwards.
#
#   ./scripts/verify.sh scripts/verify-editing.js

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${1:?usage: verify.sh <script.js>}"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/tv-launcher-verify.XXXXXX")"

cleanup() { rm -rf "${SCRATCH}"; }
trap cleanup EXIT

mkdir -p "${SCRATCH}/adblock-launcher/icons" \
         "${SCRATCH}/adblock-launcher/cache" \
         "${SCRATCH}/adblock-launcher/runtime"

cat > "${SCRATCH}/adblock-launcher/sites.json" <<'JSON'
[
  { "url": "https://example.com/", "label": "Example", "icon": null },
  { "url": "https://news.ycombinator.com/", "label": "Hacker News", "icon": null }
]
JSON

XDG_DATA_HOME="${SCRATCH}" \
TVL_VERIFY="${ROOT}/${SCRIPT}" \
  "${ROOT}/scripts/run.sh"