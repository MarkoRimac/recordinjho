#!/usr/bin/env bash
# process-recording.sh — CLI convenience: audio file → transcript + MoM, both saved
# next to the audio. (The Obsidian plugin calls transcribe.sh / summarize.sh directly
# so it can place each output in the right vault folder.)
#
# Usage:  ASSEMBLYAI_API_KEY=… ANTHROPIC_API_KEY=… ./process-recording.sh <audio> [title]

source "$(dirname "$(readlink -f "$0")")/lib/common.sh"

DIR="$(dirname "$(readlink -f "$0")")"
AUDIO="${1:-}"
TITLE="${2:-}"
[ -n "$AUDIO" ] || die "Usage: process-recording.sh <audio-file> [title]"
[ -f "$AUDIO" ] || die "Audio file not found: $AUDIO"

base="${AUDIO%.*}"
TRANSCRIPT="${base}.transcript.md"
MOM="${base}.mom.md"

"$DIR/transcribe.sh" "$AUDIO" "$TRANSCRIPT"
MOM_TITLE="$TITLE" "$DIR/summarize.sh" "$TRANSCRIPT" "$MOM"

_c_grn "Done:"
_c_grn "  transcript → $TRANSCRIPT"
_c_grn "  MoM        → $MOM"
