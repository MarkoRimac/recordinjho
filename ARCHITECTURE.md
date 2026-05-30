# Recordinjho — Audio Architecture

How Stage 1 captures **all application audio + your microphone** into a single
recording on Linux/PipeWire, while you still hear the call and others still hear you.

This document explains the *why* behind `scripts/setup-audio.sh`. If you just want to
use the tool, see the [README](README.md).

## TL;DR

It is **not** two separate channels (mic on one, output on the other). Two audio
sources are **summed (mixed) into one stream** by a virtual sink *before* recording.
PipeWire does the mixing; the recorder just reads the already-mixed result.

## The three primitives

PipeWire/PulseAudio model everything as a graph of three kinds of things:

| Kind | Role | Embedded analogy | Examples here |
|---|---|---|---|
| **Source** | Produces audio — you read *from* it | An **ADC** peripheral (analog → digital samples) | the **mic**, any `.monitor` |
| **Sink** | Consumes audio — you write *to* it | A **DAC** peripheral (digital samples → analog) | real **Speaker**, **`meeting`**, **`capture_and_play`** |
| **Application / stream** | A *client* that connects to sources and sinks | A task doing DMA to/from peripherals | **Teams**, `pw-record`, the loopback |

Two rules that explain the whole design:

- **A sink fans IN.** Every stream written to a sink is **summed** into one mix buffer.
  This is just what sinks do — mixing is not special to any one module.
- **A source fans OUT.** Any number of clients can read the same source
  *simultaneously*; each gets its own copy of the samples. No contention.

> So the mic (a source) can be read by both Teams and our recorder at once, while
> the `meeting` sink sums the mic + system audio into a single stream.

## The two key tricks

### 1. `.monitor` — reading back what a sink received

Every sink automatically exposes a companion **`.monitor` source** carrying whatever
was written into that sink's mix buffer. This is the linchpin: "record what's
playing" is built in, no kernel interception needed.

### 2. The "null sink" — a mixing bus with no hardware

A **null sink** is a sink with **no DAC behind it**: samples written to it are
discarded (think `/dev/null`). But it still has a mix buffer and a `.monitor`, so it
works as a pure **mixing bus** you can tap.

```
   null sink "meeting":
   writers ──► [ mix buffer ] ──► (DAC) ──► /dev/null   ← discarded, no analog out
                     │
                     └──► .monitor (a SOURCE) ──► readable digital tap
```

> It's called *null* because there's no hardware output — **not** because it combines.
> Combining is a property of all sinks.

## The four moving parts

`scripts/setup-audio.sh` creates three modules; `scripts/record.sh` runs the fourth
(a plain client). The recorder is **not** a sink — it *consumes* the mix.

| Module | Type | Job | Embedded analogy |
|---|---|---|---|
| `meeting` | **null sink** | Mix mic + system audio; expose result via `.monitor` | DAC wired to nothing, + a read-port on its buffer |
| `capture_and_play` | **combine sink** | Fan the default output out to the real Speaker **and** the null sink | DMA fan-out: 1 buffer → 2 DACs |
| `module-loopback` | **loopback** | Pump the mic (a source) **into** the null sink | DMA channel: ADC → sink buffer |
| `pw-record` | **client app** | Read `meeting.monitor`, write samples to a file | DMA reader: buffer → disk |

Why each exists:

- **Combine sink** (`capture_and_play`) is set as the **default output**, so every app
  plays to it. It duplicates that audio to (a) the real Speaker so you *hear* the call
  and (b) the `meeting` bus so it gets *recorded*. Without it, making the null sink the
  default would send all audio into the void — you'd hear nothing.
- **Loopback** exists because the mic is a *source*; nothing "plays" it. We need an
  active bridge that *reads* the mic and *writes* it into the `meeting` sink. Mic audio
  goes **only** into `meeting`, never to the Speaker — otherwise you'd hear yourself
  echo (~50 ms late).
- **`pw-record`** is a separate consumer hanging off the `meeting.monitor` tap. The
  null sink *produces* the mixed stream; the recorder *consumes* it.

## Full signal flow (in ADC/DAC terms)

```
  MIC (source/ADC) ──┬───────────────────────────► Teams capture stream → network (others hear you)
                     │
                     └──(module-loopback: ADC→sink wire)──┐
                                                          ▼
  Teams playback ──► capture_and_play ──(combine/fan-out)─┼──► Speaker (sink/DAC) → you HEAR
  (others' voices)   (default sink)                       │
                                                          ▼
                                              meeting (NULL sink) = mixer
                                              ├ input 1: system audio copy (from combine)
                                              ├ input 2: your mic (from loopback)
                                              └ SUMS them → .monitor (source/tap)
                                                              │
                                                              ▼
                                                    pw-record (a client app)
                                                    reads .monitor → writes file
                                                              │
                                                              ▼
                                                    ffmpeg → recordings/meeting-XXXX.ogg
```

Note the asymmetry between input and output paths:

- We changed the default **sink** (output) to `capture_and_play`, so we sit on the
  *playback* path.
- We did **not** change the default **source** (input). Teams still grabs the real mic
  directly; our loopback is just an *additional, parallel* reader of the same mic.

## What ends up in the file

`meeting.monitor` carries **one already-summed signal**: `mix(everyone_else + you)`.
`pw-record` captures it as a **stereo** stream — but "stereo" is only the channel
format (left/right). Both the system audio and your voice are present in *both*
channels; the stereo is **not** source separation.

That single mixed track is exactly what a diarizing STT service (Stage 2: AssemblyAI /
Deepgram) wants — it separates speakers from one mixed track by voice characteristics
and does not need them pre-split.

## The actual commands (from `setup-audio.sh`)

```bash
pactl load-module module-null-sink    sink_name=meeting
pactl load-module module-combine-sink sink_name=capture_and_play slaves=$HW,meeting
pactl set-default-sink                capture_and_play
pactl load-module module-loopback     source=$MIC sink=meeting latency_msec=50
# then, to record:
pw-record --target meeting.monitor out.wav   # → ffmpeg → Opus .ogg
```

`latency_msec=50` on the mic loopback is a buffering tradeoff: lower = tighter sync
between your voice and others' in the recording, but more risk of underrun glitches.
50 ms is a safe default and irrelevant to diarization.

## Stage 2 / Stage 3 data flow

Stage 1 ends at an `.ogg`. The rest is plain "file in → text out" steps, so they live in
small CLI scripts; the Obsidian plugin just orchestrates them and owns the vault writes.

```
 recordings/<name>.ogg
        │  transcribe.sh  (curl)
        ▼
   AssemblyAI:  POST /v2/upload → upload_url
                POST /v2/transcript {audio_url, speaker_labels:true, speech_models:[…]}
                poll GET /v2/transcript/{id} until "completed"
        │  utterances[] → "**Speaker A:** …" (jq)
        ▼
   transcript.md
        │  summarize.sh  (curl → Anthropic POST /v1/messages, model claude-sonnet-4-6)
        ▼
   MoM.md   (matches _Templates/Meeting Minutes.md)

 Plugin (plugin/main.ts, desktop-only):
   Start → bash start-recording.sh
   Stop  → title modal → bash stop-recording.sh (→ .ogg path on stdout)
         → bash transcribe.sh <ogg> -        (key via env, transcript on stdout)
         → vault.create(Meetings/Transcripts/<date> <title>.md)
         → bash summarize.sh - -             (transcript via stdin, MoM on stdout)
         → vault.create(Meetings/<date> <title>.md) → open it
         → (optional) bash teardown-audio.sh
```

Key boundary choices: scripts print **only data to stdout** (status → stderr) so the
plugin can capture results cleanly; **secrets pass via `child_process` env**, never argv;
and the same scripts run standalone from the terminal — the plugin adds no logic of its own.

## Common misconception (worth keeping straight)

> "The recording software is basically the null sink."

No — opposite ends. The **null sink produces** the mixed stream; the **recorder
consumes** it off `.monitor`. The null sink is the mixer/bus; `pw-record` is just a
client copying that buffer to disk.
