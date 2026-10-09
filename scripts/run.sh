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

exec "${RUNTIME}" "${ROOT}/${ENTRY}" "${@:2}"