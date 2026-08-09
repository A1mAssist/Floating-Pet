# Dual-NPU Model Voice Design

**Date:** 2026-08-09

## Goal

Keep turn-based text/image/WAV chat available while adding real MiniCPM-o 4.5 full-duplex speech on the two-Ascend HidevLab host. Realtime replies must play model-generated audio; system TTS must not represent a realtime model reply.

## Chosen Architecture

- NPU 0 keeps the existing chat adapter on remote loopback port `8000`.
- NPU 1 runs the repository's mode-aware adapter with `MINICPM_MODE=duplex` on remote loopback port `8001`.
- Windows forwards the two loopback ports to `127.0.0.1:18000` and `127.0.0.1:18001` over the existing SSH profile.
- The desktop probes chat and Duplex health independently, merges only explicitly advertised capabilities, and connects its existing realtime client to `ws://127.0.0.1:18001/v1/realtime`.
- No second protocol or renderer network path is added. Network and SSH ownership remains in the Electron main process.

This supersedes the single-resident-model deployment assumption in `2026-07-20-local-duplex-voice-design.md` for the current two-NPU HidevLab host. A single-NPU deployment may still use mode switching, but it is not the target of this delivery.

## Model Voice

Duplex startup uses the OpenBMB MiniCPM-o 4.5 Omni Demo reference:

- Source: `https://openbmb.github.io/minicpm-o-4_5-omni/videos/timbre/nezha_ref.wav`
- Format: mono, 24 kHz, 16-bit PCM WAV
- Duration: 9.536 seconds
- SHA-256: `FE5D8932013FF30A9D8114A6D62E5342999D8C2DDF8509ECFEB1EAD71CACF432`

The asset is deployed to the remote runtime and is not required in the packaged desktop application. `MINICPM_PROMPT_WAV` points to the verified remote copy. It initializes MiniCPM's audio decoder; every realtime reply remains model-generated.

## Service Changes

`service/minicpmo_server.py` gains a validated `MINICPM_DEVICE` setting used by both chat and Duplex loaders. The current host runs the updated Duplex adapter on `npu:1`; the existing chat service remains on `npu:0` until it is separately upgraded.

Duplex health is accepted only when it reports all of:

```json
{
  "status": "ready",
  "mode": "duplex",
  "fake": false,
  "capabilities": {
    "realtime": true,
    "audio_input_16k_f32": true,
    "audio_output_24k_f32": true
  }
}
```

The public realtime protocol remains `session.queue_done -> session.init -> session.created -> input.append -> response.output.delta -> response.done`. Audio input is mono float32 PCM at 16 kHz. Model audio output is mono float32 PCM at 24 kHz.

## Desktop Changes

Capability discovery keeps the chat result from the HTTP base and separately derives an HTTP health URL from the configured realtime WebSocket URL. Realtime is enabled only when that second health response is a non-fake ready Duplex service with the required input/output flags.

When realtime is active:

- microphone chunks and optional JPEG frames use the existing bounded queue;
- model `audio` deltas use `RealtimePlayback` only;
- captions use model text deltas;
- browser/system speech synthesis is never called for a model realtime reply;
- missing, malformed, timed-out, or silent model audio produces an explicit unavailable/error state rather than TTS substitution.

Turn-based chat keeps its existing text behavior and optional system speech setting. The no-system-TTS requirement applies to Duplex replies because the chat service currently returns text only.

## Deployment

The Duplex runtime is staged in a separate remote directory so the working chat service is not overwritten. Startup uses the existing Ascend environment and Python virtual environment with these effective values:

```text
MINICPM_MODE=duplex
MINICPM_DEVICE=npu:1
MINICPM_PORT=8001
MINICPM_MODEL_DIR=/workspace/user_data/models/MiniCPM-o-4.5-ascend-FlagOS
MINICPM_PROMPT_WAV=/workspace/user_data/voices/nezha_ref.wav
```

The process is detached with a PID file and bounded log under `/workspace/user_data`. Deployment first validates the reference WAV hash and Python imports, then starts the service without stopping chat on port `8000`.

## Failure Behavior

- Duplex load failure leaves chat on NPU 0 untouched.
- A non-ready or fake Duplex health response keeps the realtime control disabled.
- Realtime transport or inference failure stops capture/playback, preserves typed chat, and surfaces a bounded error code.
- Realtime never falls back to system TTS, cached model audio, or fake PCM.
- SSH tunnel loss is treated as offline and may be retried without restarting either remote model process.

## Acceptance

- Unit tests cover device validation, dual-endpoint capability merging, and the no-system-TTS realtime branch.
- Existing check, unit, service, integration, and E2E suites remain green.
- Remote `/health` on port `8001` reports real Duplex capabilities and `fake=false`.
- A real WebSocket session completes the queue/init/created handshake.
- At least one real `input.append` returns text plus non-empty finite 24 kHz model PCM and `response.done`.
- The Electron flow plays accepted model PCM and records no system speech invocation for that reply.
- Chat on port `8000` remains healthy after Duplex startup and after the realtime smoke test.

