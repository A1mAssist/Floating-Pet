# Local Duplex Voice Design

**Date:** 2026-07-20

## Goal

Add a locally testable MiniCPM-o audio/video full-duplex path while keeping the existing turn-based HTTP path and avoiding two resident model copies on resource-constrained Ascend hosts.

## Decisions

- Full duplex starts only from the assistance card's explicit `实时对话` control and stops when the card/session/input closes.
- The service has one resident backend selected by `MINICPM_MODE=chat|duplex`; it never loads simplex and duplex weights concurrently.
- The public duplex transport follows the verified Realtime WebSocket sequence: `session.queue_done`, `session.init`, `session.created`, repeated `input.append`, `response.output.delta`, `session.close`, `session.closed`.
- Audio is base64 little-endian float32, mono, 16 kHz upstream and 24 kHz downstream. Video frames are bounded JPEG base64 values.
- Duplex failures preserve text input and the existing local/system-speech fallback; the UI never claims model audio when it was not produced.
- Each duplex connection owns one model state and the local fake backend is the primary acceptance path when Ascend is unavailable.

## Components

### Service

`service/minicpmo_server.py` retains `/v1/chat/completions` for `chat` mode and adds `/v1/realtime` for `duplex` mode. The duplex loader uses the target revision's `MiniCPMODuplex` API (`prepare`, `streaming_prefill`, `streaming_generate`, `set_session_stop`). Health exposes the selected mode and capability flags. One active duplex session is allowed by default.

### Desktop main/preload

`desktop/src/realtime-client.cjs` owns the WebSocket lifecycle, event validation, bounded payloads, cancellation and close timeout. `main.cjs` exposes only start/append/stop events to the trusted renderer; `preload.cjs` exposes the narrow bridge. No renderer network access is added.

### Renderer

The assistance card gets an explicit realtime toggle. A single microphone capture pipeline emits one-second 16 kHz PCM chunks. Optional current JPEG frames are appended to the same event. Text deltas update the conversation/caption; audio deltas enter a bounded 24 kHz playback queue. Stop/close clears both capture and playback immediately.

### Boundary hardening

The existing turn-based path gains body-inclusive timeouts, media request generations, cancellation on input/session stop, truthful degraded copy, server-side part/text/pixel/audio limits, and origin/frame checks for media and IPC.

## Degraded behavior

- `chat` mode: existing remote text plus system TTS.
- `duplex` mode without reference audio, WebSocket support or backend capability: explicit unavailable state and local text fallback.
- Fake mode: deterministic text plus generated test PCM so playback and interruption are testable without model resources.

## Acceptance

- Node tests cover realtime event order, malformed events, bounded audio, cancellation and fake playback.
- Python tests cover mode gating, websocket lifecycle, input limits and fake duplex output.
- Existing check/unit tests remain green.
- A real Ascend smoke test is documented but not required while the remote resource is unavailable.
