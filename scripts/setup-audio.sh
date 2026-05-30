#!/usr/bin/env bash
# setup-audio.sh — create the app-independent recording routing.
#
#   apps ──► [capture_and_play] (combine sink, = default)
#                ├─► real HW sink   → you still hear the meeting
#                └─► [meeting]      (null sink) ◄── your mic (mic ONLY here, no echo)
#                         └─► meeting.monitor → record.sh
#
# Run this AFTER selecting the output device you want to listen on (headphones
# vs speakers): the real HW sink is captured at setup time.
#
# Env overrides:  HW=<sink-name>  MIC=<source-name>  ./setup-audio.sh

source "$(dirname "$(readlink -f "$0")")/lib/preflight.sh"
preflight_require

# Refuse to stack duplicates.
if sink_exists "$NULL_SINK_NAME" || sink_exists "$COMBINE_SINK_NAME"; then
    die "Routing already set up ('$NULL_SINK_NAME'/'$COMBINE_SINK_NAME' exist). Run teardown-audio.sh first."
fi

# Detect the REAL current default output/input before we change anything.
HW="${HW:-$(pactl get-default-sink)}"
MIC="${MIC:-$(pactl get-default-source)}"

[ -n "$HW" ]  || die "Could not determine a default output sink."
[ -n "$MIC" ] || die "Could not determine a default microphone source."
sink_exists   "$HW"  || die "Output sink '$HW' not found. Check 'pactl list short sinks'."
source_exists "$MIC" || die "Mic source '$MIC' not found. Check 'pactl list short sources'."

# Don't capture a monitor source as a 'mic' by accident.
case "$MIC" in
    *.monitor) die "Default source '$MIC' is a monitor, not a real mic. Set MIC=<your-mic>." ;;
esac

# Status → stderr (keep stdout clean for callers that capture it, e.g. the plugin).
echo "Real output (HW) : $HW" >&2
echo "Microphone       : $MIC" >&2
echo >&2

# 1) null sink = the recording bus
NULL_ID=$(pactl load-module module-null-sink \
    sink_name="$NULL_SINK_NAME" \
    sink_properties=device.description=Meeting)

# 2) combine sink fans audio out to BOTH the real HW sink AND the recording bus
COMBINE_ID=$(pactl load-module module-combine-sink \
    sink_name="$COMBINE_SINK_NAME" \
    slaves="$HW,$NULL_SINK_NAME" \
    sink_properties=device.description=CaptureAndPlay)

# 3) make the combine sink the default → every newly-started app plays here
pactl set-default-sink "$COMBINE_SINK_NAME"

# 4) feed the mic into the recording bus ONLY (never to HW → no echo)
LOOP_ID=$(pactl load-module module-loopback \
    source="$MIC" sink="$NULL_SINK_NAME" \
    latency_msec=50 source_dont_move=true sink_dont_move=true)

# Persist real default + module IDs for an exact teardown.
{
    echo "PREV_DEFAULT_SINK=$HW"
    echo "NULL_ID=$NULL_ID"
    echo "COMBINE_ID=$COMBINE_ID"
    echo "LOOP_ID=$LOOP_ID"
} > "$STATE_FILE"

_c_grn "Routing is up. Default sink is now '$COMBINE_SINK_NAME'."
{
    echo
    echo "Next:  ./scripts/record.sh"
    echo "Note:  apps already running keep their old output — move them to 'CaptureAndPlay'"
    echo "       in pavucontrol (Playback tab) or restart them. New apps follow automatically."
    echo "When done:  ./scripts/teardown-audio.sh"
} >&2
