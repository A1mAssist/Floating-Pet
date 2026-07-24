# Duplex Reliability and Screen Validation Design

**Date:** 2026-07-22

## Goal

Finish three current release gaps: sustained Duplex validation, real-model screen-cue validation, and realtime microphone capture without silent busy-time loss.

## Decisions

- Replace the latest-only microphone queue with a FIFO capped at 30 one-second chunks, including the active chunk.
- Accepted chunks preserve order and are never overwritten. Hitting the cap stops the realtime session with an explicit `audio_input_overflow` error and clears retained PCM.
- Capture and playback remain simultaneous, but the Ascend model still executes `streaming_prefill -> streaming_generate` serially. The UI and docs must not claim concurrent NPU inference or unlimited lossless buffering.
- Keep the existing validated WebSocket protocol and `RealtimeClient`; no second transport or dependency is added.
- Add one configurable real-NPU script covering a sustained session, a rejected concurrent session, sequential reconnects, and prepare/output latency percentiles.
- Add one real Chat screen-cue script with rendered normal, repeated-error, and repeated-attempt screens. The repeated-error screen is evaluated twice and must produce a stable event key that passes the existing two-observation policy.
- Extend screen evidence retention from 30 seconds to 180 seconds because real JPEG inference can exceed 45 seconds; the five-second minimum separation remains.
- Remote validation may switch the single service process from Duplex to Chat, but must restore Duplex and verify `/health` before completion.

## Acceptance

- FIFO unit test proves ordered delivery, explicit overflow, zeroization on stop, and no concurrent sends.
- A 10-chunk 1 Hz real input run sends all 10 chunks with no `input_backlog` and a clean close.
- The soak script reports count, p50, p95, max, reconnect results, and `session_busy` for the concurrent client. Default soak duration is 180 seconds and is adjustable by environment variable.
- Real screen fixtures produce: normal -> `null`, repeated error -> `repeated_error` twice with one stable key, repeated attempt -> `repeated_attempt`.
- Two real repeated-error observations at least five seconds apart and within 180 seconds produce `two_observations`.
- Local check, unit, service, integration, and Electron E2E suites remain green.

## Non-goals

- Unbounded buffering, parallel access to one model state, simultaneous Chat and Duplex weights, packaging, and Windows signing.

