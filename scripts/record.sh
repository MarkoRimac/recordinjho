#!/usr/bin/env bash
# record.sh — interactive capture: start, wait for Ctrl-C, stop & encode.
#
# Thin wrapper over start-recording.sh + stop-recording.sh so the interactive CLI
# and the plugin share one code path.
#
# Usage:  ./record.sh [name-without-extension]

source "$(dirname "$(readlink -f "$0")")/lib/preflight.sh"
preflight_require pw-record ffmpeg

DIR="$(dirname "$(readlink -f "$0")")"

"$DIR/start-recording.sh" "${1:-}" >/dev/null
echo "Recording — press Ctrl-C to stop."

STOP=0
trap 'STOP=1' INT TERM
while [ "$STOP" = 0 ]; do sleep 0.5 || true; done

echo
"$DIR/stop-recording.sh" >/dev/null
