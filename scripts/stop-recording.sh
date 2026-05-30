#!/usr/bin/env bash
# stop-recording.sh — stop the recording started by start-recording.sh and encode
# the result to Opus. Prints the final .ogg path on stdout.
#
# Usage:  ./stop-recording.sh

source "$(dirname "$(readlink -f "$0")")/lib/preflight.sh"
preflight_require pw-record ffmpeg

[ -f "$REC_STATE" ] || die "No active recording (state file $REC_STATE missing)."
# shellcheck disable=SC1090
source "$REC_STATE"
[ -n "${REC_OGG:-}" ] && [ -n "${REC_WAV:-}" ] || die "Corrupt recording state."

# Stop pw-record (SIGINT → it finalises the WAV and exits) and wait for it.
if [ -n "${REC_PID:-}" ] && kill -0 "$REC_PID" 2>/dev/null; then
    kill -INT "$REC_PID" 2>/dev/null || true
    for _ in $(seq 1 50); do
        kill -0 "$REC_PID" 2>/dev/null || break
        sleep 0.2
    done
    kill -KILL "$REC_PID" 2>/dev/null || true   # last resort if it ignored SIGINT
fi

rm -f "$REC_STATE"

if [ -s "$REC_WAV" ]; then
    _c_ylw "Encoding to Opus → $REC_OGG"
    ffmpeg -hide_banner -loglevel error -y -i "$REC_WAV" -c:a libopus -b:a 48k "$REC_OGG"
    rm -f "$REC_WAV"
    _c_grn "Saved: $REC_OGG"
    echo "$REC_OGG"
else
    rm -f "$REC_WAV"
    die "No audio was captured (empty recording)."
fi
