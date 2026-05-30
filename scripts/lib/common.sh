#!/usr/bin/env bash
# common.sh — tiny shared helpers for the cross-platform (non-audio) scripts.
#
# Unlike lib/preflight.sh, this does NOT assume PipeWire/Linux and emits no audio
# banner — transcribe.sh / summarize.sh are just HTTP tools and run anywhere with
# curl + jq.

set -euo pipefail

_c_red()  { printf '\033[0;31m%s\033[0m\n' "$*" >&2; }
_c_ylw()  { printf '\033[0;33m%s\033[0m\n' "$*" >&2; }
_c_grn()  { printf '\033[0;32m%s\033[0m\n' "$*" >&2; }

die() { _c_red "ERROR: $*"; exit 1; }

# require_cmd curl jq ...
require_cmd() {
    local missing=() c
    for c in "$@"; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
    if ((${#missing[@]})); then
        die "Missing required tool(s): ${missing[*]} (install them and retry)."
    fi
}

# require_env ASSEMBLYAI_API_KEY "AssemblyAI"
require_env() {
    local var="$1" human="${2:-$1}"
    if [ -z "${!var:-}" ]; then
        die "$human API key not set. Export $var=… and retry."
    fi
}
