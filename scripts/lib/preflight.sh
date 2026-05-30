#!/usr/bin/env bash
# preflight.sh — shared environment checks for Recordinjho audio scripts.
#
# Source this from the other scripts: `source "$(dirname "$0")/lib/preflight.sh"`
# It defines helpers and runs the supported-environment gate when you call
# `preflight_require`. On any unsupported setup it prints a clear message and
# exits non-zero rather than letting the caller misbehave.

set -euo pipefail

# --- module/sink names shared across scripts -------------------------------
NULL_SINK_NAME="meeting"
COMBINE_SINK_NAME="capture_and_play"
MONITOR_SOURCE="${NULL_SINK_NAME}.monitor"
STATE_FILE="${XDG_RUNTIME_DIR:-/tmp}/recordinjho.state"

# --- pretty printing -------------------------------------------------------
_c_red()  { printf '\033[0;31m%s\033[0m\n' "$*" >&2; }
_c_ylw()  { printf '\033[0;33m%s\033[0m\n' "$*" >&2; }
_c_grn()  { printf '\033[0;32m%s\033[0m\n' "$*"; }

die() { _c_red "ERROR: $*"; exit 1; }

banner() {
    _c_ylw "Recordinjho — built & tested on Arch + PipeWire 1.4.x."
    _c_ylw "Other audio backends/OSes are not yet supported (see README 'Compatibility')."
}

# --- the supported-environment gate ----------------------------------------
# Verifies: pactl present, server is PipeWire (pulse-compat), and the tools the
# caller needs are installed. Pass the extra binaries you need as arguments,
# e.g. `preflight_require pw-record ffmpeg`.
preflight_require() {
    banner

    if ! command -v pactl >/dev/null 2>&1; then
        _c_red "No 'pactl' found — no PulseAudio/PipeWire control socket on this machine."
        _c_red "Recordinjho currently supports only PipeWire on Linux."
        _c_red "Not yet supported (planned): genuine PulseAudio, ALSA/JACK, macOS, Windows."
        exit 1
    fi

    local server
    server="$(pactl info 2>/dev/null | sed -n 's/^Server Name: //p')"
    case "$server" in
        *"on PipeWire"*)
            : # supported: PulseAudio compat layer on top of PipeWire
            ;;
        *[Pp]ulse[Aa]udio*)
            _c_red "Detected genuine PulseAudio, not PipeWire (Server Name: $server)."
            _c_red "This tool is currently built and tested for PipeWire only;"
            _c_red "a PulseAudio path is planned but not yet supported — aborting."
            exit 1
            ;;
        *)
            _c_red "Could not confirm a PipeWire audio server (Server Name: '${server:-unknown}')."
            _c_red "Recordinjho currently supports only PipeWire on Linux — aborting."
            exit 1
            ;;
    esac

    local missing=()
    local bin
    for bin in "$@"; do
        command -v "$bin" >/dev/null 2>&1 || missing+=("$bin")
    done
    if ((${#missing[@]})); then
        _c_red "Missing required tool(s): ${missing[*]}"
        _c_red "On Arch: sudo pacman -S --needed pipewire-audio pipewire-pulse ffmpeg"
        exit 1
    fi

    # ffmpeg must actually have an Opus encoder when it's required.
    # Capture-then-grep: piping a large producer straight into `grep -q` trips
    # `set -o pipefail` (grep exits early → SIGPIPE → pipeline reports failure).
    if [[ " $* " == *" ffmpeg "* ]]; then
        local encoders
        encoders="$(ffmpeg -hide_banner -encoders 2>/dev/null || true)"
        if ! grep -qiE 'libopus' <<<"$encoders"; then
            _c_red "ffmpeg is installed but has no libopus encoder."
            _c_red "On Arch the default ffmpeg package includes it; reinstall ffmpeg."
            exit 1
        fi
    fi
}

# Returns 0 if a sink/source with the given name currently exists.
# Capture-then-grep for the same pipefail/SIGPIPE reason as above.
sink_exists() {
    local names; names="$(pactl list short sinks 2>/dev/null | awk '{print $2}')"
    grep -qx "$1" <<<"$names"
}
source_exists() {
    local names; names="$(pactl list short sources 2>/dev/null | awk '{print $2}')"
    grep -qx "$1" <<<"$names"
}
