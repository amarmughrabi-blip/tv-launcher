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

cat > "${SCRATCH}/adblock-launcher/channels.json" <<'JSON'
{
  "channels": [
    {
      "name": "Al Jazeera",
      "url": "https://live-hls-apps-aja-fa.getaj.net/AJA/01.m3u8",
      "genre": "news",
      "country": "QA",
      "res": "1920x1080",
      "logo": null
    },
    {
      "name": "BBC News",
      "url": "https://example.com/news.m3u8",
      "genre": "news",
      "country": "GB",
      "res": "1280x720",
      "logo": null
    },
    {
      "name": "Sky Sports",
      "url": "https://example.com/sports.m3u8",
      "genre": "sports",
      "country": "GB",
      "res": "1920x1080",
      "logo": null
    },
    {
      "name": "Cartoon Network",
      "url": "https://example.com/kids.m3u8",
      "genre": "kids",
      "country": "US",
      "res": "640x360",
      "logo": null
    },
    {
      "name": "Dead Channel",
      "url": "http://127.0.0.1:9/dead.m3u8",
      "genre": "news",
      "country": "ZZ",
      "res": "1920x1080",
      "logo": null
    },
    {
      "name": "Unreachable Channel",
      "url": "http://192.0.2.1:8080/hangs.m3u8",
      "genre": "news",
      "country": "ZZ",
      "res": "1920x1080",
      "logo": null
    },
    {
      "name": "MTV",
      "url": "https://example.com/music.m3u8",
      "genre": "music",
      "country": "US",
      "res": "1920x1080",
      "logo": null
    }
  ]
}
JSON

XDG_DATA_HOME="${SCRATCH}" \
TVL_VERIFY="${ROOT}/${SCRIPT}" \
TVL_DEBUG_INPUT=1 \
  "${ROOT}/scripts/run.sh"