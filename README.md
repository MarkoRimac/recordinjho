# Recordinjho

A self-hosted, tool-independent meeting recorder + transcription + notes pipeline —
a cheaper, more flexible alternative to Teams Premium meeting notes.

Record **any** online meeting regardless of which app it runs in (Teams, Google Meet,
Skype, a browser tab, …), send the audio to a speaker-diarizing transcription service,
and have an LLM turn the transcript into Minutes-of-Meeting notes you can paste into
Obsidian.

## Why

Teams Premium meeting notes cost ~$10/user/month and only work inside Teams. Doing it
yourself:

- **Tool-independent** — captures at the OS audio level, so it works for Meet, Skype,
  any browser call, not just Teams.
- **Cheap** — speaker-diarizing STT runs ~$0.12–0.26 per meeting-hour
  (AssemblyAI / Deepgram), and the LLM summary is pennies of tokens per transcript.
  You'd need ~40+ hours/month before it approaches the Teams Premium flat fee.
- **Yours** — the audio and transcripts stay on your machine until you choose to send
  a file to a transcription API.

## The 3-stage pipeline

```
(1) capture audio   →   (2) diarized transcript   →   (3) LLM summary → Obsidian
    [THIS REPO,             [AssemblyAI / Deepgram        [Claude / OpenAI →
     Stage 1 today]          — "who said what"]            MoM note]
```

**Stage 1 (implemented here)** captures all application audio **plus** your microphone
into a single Opus file, while you still hear the meeting normally and other
participants still hear you — with no echo of your own voice.

Stages 2 and 3 are on the roadmap (see below).

## How Stage 1 works

PipeWire (and PulseAudio) expose every output device's `.monitor` source, so "record
system audio" is built in. To get **everyone + you** in one clean track without
hearing yourself, the routing is:

```
apps ──► [capture_and_play]  (combine sink, set as default output)
              ├─► real HW sink   → you hear the meeting normally
              └─► [meeting]      (null sink)  ◄── your mic (mic ONLY here)
                       └─► meeting.monitor → pw-record → ffmpeg → .ogg
```

- Every app plays to the **combine sink**, which duplicates audio to your real
  speakers/headphones (so you hear it) **and** to the `meeting` null sink.
- Your **mic** is looped into the `meeting` sink **only** — never to your output — so
  your voice is recorded but you don't hear yourself echoed.
- `meeting.monitor` therefore carries *all app audio + your voice*, which is exactly
  what gets recorded and (later) sent for diarization.

> A simpler "null-sink-only" recipe re-plays the mic loopback through the monitor and
> makes you hear yourself. The combine-sink design above is what avoids that.

For a full technical walkthrough (sources vs sinks, why a null sink, the `.monitor`
tap, the combine sink, the loopback, and how it all mixes into one track), see
[ARCHITECTURE.md](ARCHITECTURE.md).

## Prerequisites

- **Linux with PipeWire** (the modern Arch default). Verify with:
  `pactl info | grep "Server Name"` → should say `PulseAudio (on PipeWire …)`.
- `pipewire-pulse` (provides `pactl`), `pw-record`, and `ffmpeg` with `libopus`.
  On Arch: `sudo pacman -S --needed pipewire-audio pipewire-pulse ffmpeg`.
- Optional but handy: `pavucontrol` (GUI to verify/move audio streams).

The scripts check all of this on every run and **refuse to run with a clear message**
if the environment isn't supported (see Compatibility).

## Usage

```bash
# 1. Pick your output device first (headphones vs speakers), THEN set up routing:
./scripts/setup-audio.sh

# 2. Start recording (Ctrl-C to stop → encodes to recordings/meeting-<UTC>.ogg):
./scripts/record.sh

# 3. When the meeting is over, restore your normal audio:
./scripts/teardown-audio.sh
```

Recordings land in `recordings/` (git-ignored). Override device autodetection with
`HW=<sink> MIC=<source> ./scripts/setup-audio.sh`.

## Stage 2 — transcription & summary (CLI)

Turn a recording into a diarized transcript (AssemblyAI) and a Minutes-of-Meeting
note (Claude). Put your keys in a git-ignored `.env` (see `.env.example`):

```bash
cp .env.example .env          # then fill in ASSEMBLYAI_API_KEY + ANTHROPIC_API_KEY
set -a; source .env; set +a

# Transcript only (diarized, "**Speaker A:** …"):
ASSEMBLYAI_LANG_DETECT=true ./scripts/transcribe.sh recordings/<file>.ogg out.md

# MoM only (from a transcript):
./scripts/summarize.sh out.md mom.md

# Or both at once → recordings/<file>.transcript.md and .mom.md:
./scripts/process-recording.sh recordings/<file>.ogg "Optional Title"
```

Useful env: `ASSEMBLYAI_LANGUAGE=hr` (or `ASSEMBLYAI_LANG_DETECT=true`),
`ASSEMBLYAI_SPEECH_MODEL` (default `universal-2`), `RECORDINJHO_MODEL`
(default `claude-sonnet-4-6`). These scripts are cross-platform (just need
`curl` + `jq`) — no PipeWire required.

## Stage 3 — Obsidian plugin

A desktop-only plugin (`plugin/`) that drives the whole flow from inside Obsidian:

- **Start** → records (status-bar `🔴 Recording`).
- **Stop** → immediately encodes the `.ogg` and **restores your normal audio** (tears
  down the routing) before anything is sent anywhere.
- Then a dialog asks whether to **transcribe & summarize** at all — pick a title and
  proceed, or **"Just keep the audio"** to send nothing. If you proceed, it transcribes
  (AssemblyAI), summarizes (Claude), and writes the transcript + MoM notes into the vault.
- A configurable **long-recording warning** (default 2h) pops a reminder so a forgotten
  recording doesn't run forever.

Plugin recordings are saved **into the vault** (default `Recordings/Audio/`, configurable
in settings) so kept-but-not-transcribed audio lives with your notes. The CLI scripts
still default to the repo's `recordings/`. Your audio is always saved locally first, so a
failed/declined transcription never loses it. Kept one for later? The command
**"Process an existing recording"** lists the `.ogg` files in that folder (newest first)
and runs the same transcribe + summarize flow.

> Audio files are large. If your vault is under git/sync (e.g. obsidian-git), exclude the
> audio folder — add `Recordings/Audio/` to the vault's `.gitignore` or Obsidian's
> Settings → Files & Links → Excluded files.

```bash
cd plugin && npm install && npm run build
# then symlink the build into your vault:
ln -sf "$PWD/main.js"       <vault>/.obsidian/plugins/recordinjho/main.js
ln -sf "$PWD/manifest.json" <vault>/.obsidian/plugins/recordinjho/manifest.json
```

Enable **Recordinjho** under Settings → Community plugins, then set your API keys,
folders, and language in its settings tab. The Stage-1/2 scripts do the real work;
the plugin just orchestrates them and writes the notes. (Keys are stored in the
plugin's `data.json` inside the vault — plaintext, so don't sync that file publicly.)
Optionally install/update via **BRAT** from GitHub releases.

## Compatibility

| Environment | Status |
|---|---|
| Linux + **PipeWire** (PulseAudio compat) | ✅ Supported — built & tested (Arch, PipeWire 1.4.x) |
| Linux + **genuine PulseAudio** | ⚠️ Warned & refused — planned next (same modules exist there) |
| Linux + ALSA-only / JACK | ⚠️ Warned & refused — future |
| macOS | ⚠️ Warned & refused — future (needs a virtual device like BlackHole) |
| Windows | ⚠️ Warned & refused — future (WASAPI loopback / getDisplayMedia) |

If you run the scripts on an unsupported setup they detect it and exit with an
explanation rather than misbehaving.

## Known limitations

- The combine sink's hardware slave is fixed at setup time. If you switch output
  device (e.g. plug in headphones and the sink name changes), re-run
  `setup-audio.sh`. **Select your output device first, then run setup.**
- The routing modules are **not persistent** — they're gone on logout/reboot
  (intentional for now; systemd `--user` persistence is on the roadmap).
- Apps already running before `setup-audio.sh` keep their old output until you move
  them to `CaptureAndPlay` in `pavucontrol` or restart them. New apps follow the
  default automatically.

## Roadmap

- [x] **Stage 1** — app-independent loopback capture → Opus file
- [x] **Stage 2** — AssemblyAI diarized transcript + Claude Minutes-of-Meeting (CLI)
- [x] **Stage 3** — Obsidian plugin orchestrating the whole flow into the vault
- [ ] systemd `--user` service so the routing is set up automatically at login
- [ ] genuine-PulseAudio support, then other backends/OSes
- [ ] optional transcript cleanup / deletion after summarizing
