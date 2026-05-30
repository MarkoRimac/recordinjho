#!/usr/bin/env bash
# transcribe.sh — send an audio file to AssemblyAI with speaker diarization and
# emit a speaker-labelled Markdown transcript.
#
# Usage:   ASSEMBLYAI_API_KEY=… ./transcribe.sh <audio-file> [out.md|-]
#   out.md   write transcript there
#   -        write to stdout (default if omitted)
#
# Optional env:
#   ASSEMBLYAI_BASE         API base (default https://api.assemblyai.com)
#   ASSEMBLYAI_MIN_SPEAKERS / ASSEMBLYAI_MAX_SPEAKERS  hint the speaker count
#   ASSEMBLYAI_LANGUAGE     language code, e.g. hr, en, de (omit = English default)
#   ASSEMBLYAI_LANG_DETECT  set to 1/true to auto-detect language instead
#   ASSEMBLYAI_SPEECH_MODEL speech model (default universal-2; or universal-3-pro)

source "$(dirname "$(readlink -f "$0")")/lib/common.sh"
require_cmd curl jq
require_env ASSEMBLYAI_API_KEY "AssemblyAI"

AUDIO="${1:-}"
OUT="${2:--}"
[ -n "$AUDIO" ] || die "Usage: transcribe.sh <audio-file> [out.md|-]"
[ -f "$AUDIO" ] || die "Audio file not found: $AUDIO"

BASE="${ASSEMBLYAI_BASE:-https://api.assemblyai.com}"
AUTH="Authorization: $ASSEMBLYAI_API_KEY"

# POST/GET wrappers that capture the body and fail loudly on API errors.
api_post() {  # api_post <path> <content-type> <data>
    local path="$1" ctype="$2" data="$3" resp
    resp="$(curl -sS -X POST "$BASE$path" -H "$AUTH" -H "Content-Type: $ctype" --data "$data")" \
        || die "Request to $path failed (network/curl)."
    printf '%s' "$resp"
}

_c_ylw "Uploading $(basename "$AUDIO") to AssemblyAI…"
UPLOAD_RESP="$(curl -sS -X POST "$BASE/v2/upload" -H "$AUTH" --data-binary @"$AUDIO")" \
    || die "Upload failed (network/curl)."
UPLOAD_URL="$(printf '%s' "$UPLOAD_RESP" | jq -r '.upload_url // empty')"
[ -n "$UPLOAD_URL" ] || die "Upload returned no URL. Response: $UPLOAD_RESP"

# Build the transcript request (speaker diarization on).
LANG_DETECT=false
case "${ASSEMBLYAI_LANG_DETECT:-}" in 1|true|TRUE|yes) LANG_DETECT=true ;; esac
REQ="$(jq -n --arg url "$UPLOAD_URL" \
        --arg model "${ASSEMBLYAI_SPEECH_MODEL:-universal-2}" \
        --arg lang "${ASSEMBLYAI_LANGUAGE:-}" \
        --argjson detect "$LANG_DETECT" \
        --argjson mins "${ASSEMBLYAI_MIN_SPEAKERS:-null}" \
        --argjson maxs "${ASSEMBLYAI_MAX_SPEAKERS:-null}" '
    {audio_url:$url, speaker_labels:true, speech_models:[$model]}
    + (if $lang != "" then {language_code:$lang} elif $detect then {language_detection:true} else {} end)
    + (if $mins != null or $maxs != null
       then {speaker_options: ({} + (if $mins!=null then {min_speakers_expected:$mins} else {} end)
                                 + (if $maxs!=null then {max_speakers_expected:$maxs} else {} end))}
       else {} end)')"

CREATE_RESP="$(api_post /v2/transcript application/json "$REQ")"
ID="$(printf '%s' "$CREATE_RESP" | jq -r '.id // empty')"
[ -n "$ID" ] || die "Could not create transcript. Response: $CREATE_RESP"

_c_ylw "Transcribing (id=$ID)… this runs in the background on AssemblyAI."
STATUS="" RESP=""
while :; do
    RESP="$(curl -sS "$BASE/v2/transcript/$ID" -H "$AUTH")" || die "Polling failed (network/curl)."
    STATUS="$(printf '%s' "$RESP" | jq -r '.status // "unknown"')"
    case "$STATUS" in
        completed) break ;;
        error)     die "Transcription failed: $(printf '%s' "$RESP" | jq -r '.error // "unknown error"')" ;;
        queued|processing) sleep 4 ;;
        *)         die "Unexpected status '$STATUS'. Response: $RESP" ;;
    esac
done

# Format: speaker-labelled turns, or fall back to the flat text (single speaker).
BODY="$(printf '%s' "$RESP" | jq -r '
    if (.utterances // []) | length > 0
    then [.utterances[] | "**Speaker \(.speaker):** \(.text)"] | join("\n\n")
    else (.text // "") end')"

DUR="$(printf '%s' "$RESP" | jq -r '.audio_duration // empty')"
HEADER="<!-- Recordinjho transcript
source: $(basename "$AUDIO")
duration_s: ${DUR:-?}
transcribed_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)
-->
"

if [ "$OUT" = "-" ]; then
    printf '%s\n%s\n' "$HEADER" "$BODY"
else
    printf '%s\n%s\n' "$HEADER" "$BODY" > "$OUT"
    _c_grn "Transcript written: $OUT"
fi
