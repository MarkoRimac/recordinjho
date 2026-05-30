#!/usr/bin/env bash
# teardown-audio.sh — undo setup-audio.sh: restore the default sink and unload
# the modules. Idempotent: safe to run when nothing is loaded.

source "$(dirname "$(readlink -f "$0")")/lib/preflight.sh"
preflight_require

# Restore the previous default sink and unload by recorded IDs if we have state.
if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    source "$STATE_FILE"
    if [ -n "${PREV_DEFAULT_SINK:-}" ] && sink_exists "$PREV_DEFAULT_SINK"; then
        pactl set-default-sink "$PREV_DEFAULT_SINK" 2>/dev/null \
            && echo "Restored default sink → $PREV_DEFAULT_SINK"
    fi
    # Unload loopback first, then combine, then null (reverse of creation).
    for id in "${LOOP_ID:-}" "${COMBINE_ID:-}" "${NULL_ID:-}"; do
        [ -n "$id" ] && pactl unload-module "$id" 2>/dev/null \
            && echo "Unloaded module #$id"
    done
    rm -f "$STATE_FILE"
fi

# Fallback / belt-and-suspenders: unload any leftover modules by sink name.
leftovers=$(pactl list short modules 2>/dev/null \
    | grep -E "sink_name=(${NULL_SINK_NAME}|${COMBINE_SINK_NAME})\b|sink=${NULL_SINK_NAME}\b" \
    | awk '{print $1}')
for id in $leftovers; do
    pactl unload-module "$id" 2>/dev/null && echo "Unloaded leftover module #$id"
done

if sink_exists "$NULL_SINK_NAME" || sink_exists "$COMBINE_SINK_NAME"; then
    _c_ylw "Some routing sinks still present — check 'pactl list short modules'."
else
    _c_grn "Teardown complete — routing removed."
fi
