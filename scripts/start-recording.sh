#!/usr/bin/env bash
# start-recording.sh — begin a recording in the background and return immediately.
#
# Ensures the Stage-1 routing is up (runs setup-audio.sh if needed), launches
# pw-record detached, and records the PID + file paths to $REC_STATE so
# stop-recording.sh can finish the job. Designed for the Obsidian plugin, but
# usable directly too.
#
# Usage:  ./start-recording.sh [name-without-extension]

source "$(dirname "$(readlink -f "$0")")/lib/preflight.sh"
preflight_require pw-record

DIR="$(dirname "$(readlink -f "$0")")"
REPO_DIR="$(dirname "$DIR")"

# Refuse to start a second recording on top of a live one.
if [ -f "$REC_STATE" ]; then
    # shellcheck disable=SC1090
    source "$REC_STATE"
    if [ -n "${REC_PID:-}" ] && kill -0 "$REC_PID" 2>/dev/null; then
        die "A recording is already running (pid $REC_PID). Run stop-recording.sh first."
    fi
    rm -f "$REC_STATE"   # stale state, clean it
fi

# Bring up the routing if it isn't already.
if ! source_exists "$MONITOR_SOURCE"; then
    _c_ylw "Audio routing not up — running setup-audio.sh…"
    "$DIR/setup-audio.sh"
fi

# Output dir: env override (the plugin points this at a vault folder) or repo default.
REC_DIR="${RECORDINJHO_REC_DIR:-$REPO_DIR/recordings}"
mkdir -p "$REC_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="${1:-meeting-$STAMP}"
WAV="$REC_DIR/.${NAME}.tmp.wav"
OGG="$REC_DIR/${NAME}.ogg"

# Launch pw-record fully detached (own session, survives this script exiting).
# The inner shell writes its own PID, then exec's pw-record so the PID stays valid.
PWWAV="$WAV" setsid bash -c 'echo $$ > "$0"; exec pw-record --target "'"$MONITOR_SOURCE"'" "$PWWAV"' \
    "$REC_STATE.pid" >/dev/null 2>&1 < /dev/null &
disown 2>/dev/null || true

# Wait briefly for the PID file, then assemble the state file.
REC_PID=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -s "$REC_STATE.pid" ] && REC_PID="$(cat "$REC_STATE.pid")" && break
    sleep 0.2
done
rm -f "$REC_STATE.pid"
[ -n "$REC_PID" ] && kill -0 "$REC_PID" 2>/dev/null || die "pw-record failed to start."

{
    echo "REC_PID=$REC_PID"
    echo "REC_WAV=$WAV"
    echo "REC_OGG=$OGG"
} > "$REC_STATE"

_c_grn "Recording started (pid $REC_PID) → $OGG"
echo "$OGG"
