#!/usr/bin/env bash
# record.sh — capture the recording bus (all app audio + your mic) to Opus .ogg.
#
# Records meeting.monitor to a temp WAV; press Ctrl-C to stop, then it encodes to
# a timestamped Opus file under recordings/.
#
# Usage:  ./record.sh [output-name-without-extension]
#
# pw-record runs in the FOREGROUND: a terminal Ctrl-C delivers SIGINT to the whole
# process group, pw-record finalises the WAV and exits, and the script then encodes.
# The INT/TERM trap is just so bash doesn't abort before reaching the encode step.

source "$(dirname "$(readlink -f "$0")")/lib/preflight.sh"
preflight_require pw-record ffmpeg

if ! source_exists "$MONITOR_SOURCE"; then
    die "Recording bus '$MONITOR_SOURCE' not found. Run ./scripts/setup-audio.sh first."
fi

REPO_DIR="$(dirname "$(dirname "$(readlink -f "$0")")")"
REC_DIR="$REPO_DIR/recordings"
mkdir -p "$REC_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="${1:-meeting-$STAMP}"
WAV="$REC_DIR/.${NAME}.tmp.wav"
OGG="$REC_DIR/${NAME}.ogg"

trap 'echo' INT TERM   # swallow the signal so we fall through to encoding below

echo "Recording '$MONITOR_SOURCE' → $OGG"
echo "Press Ctrl-C to stop."

# Foreground capture. On Ctrl-C, pw-record exits ~130; don't let set -e abort us.
pw-record --target "$MONITOR_SOURCE" "$WAV" || true

if [ -s "$WAV" ]; then
    echo "Encoding to Opus → $OGG"
    ffmpeg -hide_banner -loglevel error -y -i "$WAV" -c:a libopus -b:a 48k "$OGG"
    rm -f "$WAV"
    _c_grn "Saved: $OGG"
else
    rm -f "$WAV"
    die "No audio was captured (empty recording)."
fi
