#!/usr/bin/env bash
# summarize.sh — turn a transcript into a Minutes-of-Meeting (MoM) Markdown note
# using the Claude (Anthropic) Messages API.
#
# Usage:   ANTHROPIC_API_KEY=… ./summarize.sh <transcript-file|-> [out.md|-]
#
# Optional env:
#   RECORDINJHO_MODEL   Claude model (default claude-sonnet-4-6)
#   MOM_DATE / MOM_TIME date/time stamped into the note (default: now, local)
#   MOM_TITLE           a meeting title to use in the H1 (default: model-suggested)

source "$(dirname "$(readlink -f "$0")")/lib/common.sh"
require_cmd curl jq
require_env ANTHROPIC_API_KEY "Anthropic"

SRC="${1:-}"
OUT="${2:--}"
[ -n "$SRC" ] || die "Usage: summarize.sh <transcript-file|-> [out.md|-]"

# Read from a real file (jq --rawfile needs a path); buffer stdin to a temp if needed.
TMP=""
cleanup() { [ -n "$TMP" ] && rm -f "$TMP"; }
trap cleanup EXIT
if [ "$SRC" = "-" ]; then
    TMP="$(mktemp)"; cat > "$TMP"; SRC="$TMP"
fi
[ -f "$SRC" ] || die "Transcript not found: $SRC"

MODEL="${RECORDINJHO_MODEL:-claude-sonnet-4-6}"
MOM_DATE="${MOM_DATE:-$(date +%Y-%m-%d)}"
MOM_TIME="${MOM_TIME:-$(date +%H:%M)}"
TITLE_HINT="${MOM_TITLE:-}"

SYSTEM="You are a meticulous assistant that writes Minutes of Meeting (MoM) from a
diarized transcript. The transcript labels speakers as 'Speaker A', 'Speaker B', etc.
Infer real names from context only when clearly stated; otherwise keep the labels.

Output ONLY the Markdown note — no preamble, no code fences. Start with EXACTLY this
YAML frontmatter (fill values; keep keys):
---
date: ${MOM_DATE}
time: \"${MOM_TIME}\"
project: \"<best guess from content, else empty>\"
attendees: [<speaker names or labels>]
type: meeting
tags:
  - meeting
---

Then the body:
# Meeting — ${MOM_DATE}${TITLE_HINT:+: ${TITLE_HINT}}

**Project:** <…>
**Date:** ${MOM_DATE} ${MOM_TIME}
**Type:** \`kickoff\` | \`weekly\` | \`review\` | \`rfq\` | \`internal\` | \`ad-hoc\` | \`1on1\`

## Summary
2–4 sentence overview.

## Attendees / Speakers
- bullet per speaker (name or label, + role if stated)

## Key Discussion Points
- concise bullets grouped logically

## Decisions
- explicit decisions made (or 'None recorded')

## Action Items
- [ ] Owner — task (due if mentioned)

## Open Questions / Next Steps
- bullets

Be faithful to the transcript; do not invent facts. Keep it tight and scannable."

PAYLOAD="$(jq -n --arg model "$MODEL" --arg sys "$SYSTEM" --rawfile t "$SRC" '
    {model:$model, max_tokens:2000, system:$sys,
     messages:[{role:"user", content:("Here is the meeting transcript:\n\n" + $t)}]}')"

RESP="$(curl -sS https://api.anthropic.com/v1/messages \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    --data "$PAYLOAD")" || die "Request to Anthropic failed (network/curl)."

ERR="$(printf '%s' "$RESP" | jq -r '.error.message // empty')"
[ -z "$ERR" ] || die "Anthropic API error: $ERR"

MOM="$(printf '%s' "$RESP" | jq -r '.content[0].text // empty')"
[ -n "$MOM" ] || die "Empty response from Anthropic. Raw: $RESP"

if [ "$OUT" = "-" ]; then
    printf '%s\n' "$MOM"
else
    printf '%s\n' "$MOM" > "$OUT"
    _c_grn "MoM written: $OUT"
fi
