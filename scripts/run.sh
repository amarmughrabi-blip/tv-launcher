#!/usr/bin/env bash
# Launch the app on the ECS runtime.
#
# The runtime is invoked by path from vendor/ rather than through the `electron`
# npm shim, so `npm install` cannot replace it with a build that has no Widevine
# CDM.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="${ROOT}/vendor/ecs-dist/electron"
ENTRY="${1:-main.js}"

die() { printf '\033[31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[[ -x "${RUNTIME}" ]] || die "ECS runtime missing — run scripts/setup-ecs.sh first"
[[ -f "${ROOT}/${ENTRY}" ]] || die "entry point '${ENTRY}' not found"

# chrome-sandbox cannot be setuid on this host, so Chromium falls back to the
# user-namespace sandbox. That still leaves the GPU process unable to start,
# which aborts the app at launch with "GPU process isn't usable. Goodbye.".
# Disabling only the GPU sandbox is enough and leaves the renderer sandbox on.
# Extra flags can be appended through TVL_EXTRA_FLAGS.
exec "${RUNTIME}" \
  --disable-gpu-sandbox \
  ${TVL_EXTRA_FLAGS:-} \
  "${ROOT}/${ENTRY}" "${@:2}"