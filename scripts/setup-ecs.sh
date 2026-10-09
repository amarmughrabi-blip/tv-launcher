#!/usr/bin/env bash
# Install Castlabs ECS (Electron for Content Security) as the application runtime.
#
# Stock Electron does not bundle the Widevine CDM: Google does not grant
# redistribution rights for it. ECS installs the CDM at runtime through Google's
# own component updater, which keeps the application covered by the licence
# Google holds for those codecs.
#
# The ECS dist directory *is* an Electron dist directory, so the binary can be
# executed directly. We deliberately do not install the `electron` npm package:
# it is only a binary downloader and path resolver, and Electron's runtime
# injects `require('electron')` into the app itself. Keeping the runtime in
# vendor/ and invoked by path means `npm install` can never clobber it.

set -euo pipefail

ECS_VERSION="${ECS_VERSION:-44.5.1}"
ECS_TAG="v${ECS_VERSION}+wvcus"
ECS_ASSET="electron-v${ECS_VERSION}+wvcus-linux-x64.zip"
ECS_URL="https://github.com/castlabs/electron-releases/releases/download/${ECS_TAG}/${ECS_ASSET}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="${ROOT}/vendor"
ECS_DIST="${VENDOR}/ecs-dist"
RUNTIME="${ECS_DIST}/electron"

info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mxx\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || die "curl is required"
command -v unzip >/dev/null || die "unzip is required"

mkdir -p "${VENDOR}"

if [[ ! -x "${RUNTIME}" ]]; then
  info "downloading ECS ${ECS_TAG} (linux-x64)"
  curl -fL --progress-bar -o "${VENDOR}/${ECS_ASSET}" "${ECS_URL}"
  info "extracting"
  rm -rf "${ECS_DIST}"
  mkdir -p "${ECS_DIST}"
  unzip -q "${VENDOR}/${ECS_ASSET}" -d "${ECS_DIST}"
  rm -f "${VENDOR}/${ECS_ASSET}"
  [[ -x "${RUNTIME}" ]] || die "ECS extraction produced no electron binary"
else
  info "ECS runtime already present"
fi

# ECS ships chrome-sandbox needing setuid root, which is not appropriate here.
# Chromium's user-namespace sandbox is used instead; without it Electron cannot
# start at all in most containerised and some desktop environments.
if [[ -f "${ECS_DIST}/chrome-sandbox" && ! -u "${ECS_DIST}/chrome-sandbox" ]]; then
  warn "chrome-sandbox is not setuid; relying on the user-namespace sandbox"
fi

info "installing npm dependencies"
( cd "${ROOT}" && npm install --no-audit --no-fund )

REPORTED="$("${RUNTIME}" --version 2>/dev/null | head -1 || echo '<failed>')"
info "runtime reports: ${REPORTED}"
[[ "${REPORTED}" == "v${ECS_VERSION}" ]] \
  || die "expected v${ECS_VERSION} from ECS, got '${REPORTED}'"

info "ECS ${ECS_TAG} ready at ${RUNTIME}"