# HarmonyOS NEXT PC Product Port Design

## Goal

Ship the existing Floating Pet product on HarmonyOS NEXT PC without replacing its UI or weakening its network boundary. The HarmonyOS build must run the current Web renderer inside ArkWeb and provide the native capabilities that Electron currently exposes through `window.pet`.

The target is HarmonyOS 6.1.0 / API 23 on a `2in1` device. A feature is considered implemented only when it returns a real result or a stable, user-visible failure. No unsupported operation may report success.

## Chosen Approach

The previously approved route 2 is a hybrid port:

- Keep the current HTML, CSS, renderer state machine, Web Audio capture, camera preview, and realtime playback.
- Replace Electron Main/Preload with a narrow ArkTS bridge.
- Keep HTTP and WebSocket ownership in native code so ArkWeb remains subject to `connect-src 'none'`.
- Use native display/window snapshots for screen frames because ArkWeb only exposes home-screen capture and cannot select an arbitrary window or display with Electron-equivalent semantics.

The rejected alternatives are direct networking from ArkWeb, which breaks the existing security boundary, and a full ArkUI/NDK rewrite, which adds large UI and media risk before the product behavior is proven on the target hardware.

## Source Layout

The production project lives in `harmony/`; the existing untracked `harmony-mock/` scaffold is migrated rather than maintained as a second product.

- `harmony/entry/src/main/ets/bridge/ProductBridge.ets`: validates and dispatches the single bridge method.
- `harmony/entry/src/main/ets/model/ModelClient.ets`: `/health`, chat, and screen-analysis HTTP requests.
- `harmony/entry/src/main/ets/realtime/RealtimeClient.ets`: bounded realtime WebSocket state machine.
- `harmony/entry/src/main/ets/capture/CaptureService.ets`: permission-gated source enumeration and JPEG snapshots.
- `harmony/entry/src/main/ets/platform/WindowService.ets`: move, snap, focus, and exit operations.
- `harmony/entry/src/main/ets/pages/Index.ets`: ArkWeb host, JavaScript proxy registration, navigation blocking, and media permission mediation.
- `harmony/entry/src/main/resources/rawfile/harmony-bridge.js`: adapts the native proxy to the existing `window.pet` contract.
- `harmony/scripts/sync-renderer.mjs`: synchronizes platform-neutral renderer files from `desktop/` before build.

Platform-specific HTML/CSS adaptations remain in the Harmony project. Shared application logic is synchronized and verified instead of being edited independently.

## Bridge Contract

ArkWeb receives one asynchronous native method:

```text
FloatPetNative.invoke(method: string, payloadJson: string) -> Promise<string>
```

The result string is a JSON envelope:

```json
{ "ok": true, "value": {} }
```

or:

```json
{ "ok": false, "error": { "code": "stable_code", "message": "user-safe message" } }
```

Only explicit method names are accepted. Method names, JSON depth, strings, arrays, media payloads, and total payload length are bounded before native work starts. Native events are sent through `WebviewController.runJavaScript()` to one frozen JavaScript event receiver. Event values are serialized with `JSON.stringify`; they are never interpolated as executable source fragments.

The bridge exposes these operations:

- `window.beginDrag`, `window.moveDrag`, `window.endDrag`, `window.focus`
- `capture.listSources`, `capture.selectSource`, `capture.frame`
- `model.capabilities`, `model.chat`, `model.analyzeScreen`, `model.cancelScreenAnalysis`
- `realtime.start`, `realtime.append`, `realtime.stop`
- `app.updateState`, `app.rendererReady`, `app.quit`

`window.setClickThrough` returns `unsupported` because HarmonyOS has no Electron-equivalent selective forwarding API. The renderer treats this as a platform limitation, not a successful click-through state.

## Data Flow

### Chat

The renderer validates and captures optional camera/audio data, then calls `model.chat`. ArkTS validates the request again, POSTs the OpenAI-compatible body to `/v1/chat/completions`, bounds the response, validates `choices[0].message.content`, and returns either the remote response or the same local fallback semantics as Electron.

`model.capabilities` calls `/health` with a 3-second timeout and maps only the service's declared capability fields. The UI therefore cannot enable media based on assumptions.

### Realtime

ArkTS opens `/v1/realtime?mode=audio|video`. It enforces the existing sequence:

```text
session.queue_done -> session.init -> session.created
input.append -> response.output.delta* -> response.done
session.close -> session.closed
```

Only one append may wait for output at a time. Audio is canonical base64 float32 mono at 16 kHz, video is at most two JPEG frames of at most 1 MiB each, and output audio must be float32 mono at 24 kHz. Unknown, oversized, malformed, out-of-order, or mismatched-response events close the session with a stable protocol error.

### Screen Sources

`capture.listSources` requests `CUSTOM_SCREEN_CAPTURE`, then combines live displays with visible main windows when `Window.SessionManager` is available. A failure to enumerate windows does not hide usable displays.

`capture.frame` captures the selected display with `screenshot.capture()` or the selected window with `getMainWindowSnapshot()`. It downsizes to at most 960 by 540, encodes JPEG at quality 72, rejects output above 1 MiB, and releases `PixelMap` and `ImagePacker` resources in all paths.

The shared renderer recognizes a native-frame screen handle. It does not call `getDisplayMedia()` on HarmonyOS; all existing chat, periodic screen analysis, and realtime visual paths consume `capture.frame` through the same `captureVisualContext()` entry point.

### Camera And Microphone

The page keeps `navigator.mediaDevices.getUserMedia()`. ArkWeb's `onPermissionRequest` accepts only the packaged rawfile origin and only audio/video capture resources. ArkTS first requests matching system `MICROPHONE` and `CAMERA` permissions and grants the ArkWeb request only when every required system grant succeeds.

### Window Lifecycle

The UI continues sending absolute drag positions. ArkTS bounds coordinates to live display work areas, moves the product window, and applies the existing edge-snap projection on release. The implementation does not claim native `startMoving()` because a JavaScript proxy callback is not an ArkUI touch-down callback.

On shutdown or `UIAbility.onDestroy`, the bridge cancels HTTP operations, closes realtime transport, releases capture resources, removes the JavaScript proxy, and terminates the ability.

## Security

- ArkWeb loads only packaged `rawfile` content; top-level navigation and new windows are denied.
- The Web CSP keeps `connect-src 'none'`; secrets and Bearer tokens never enter page JavaScript.
- The JavaScript proxy exports only `invoke`; the native dispatcher has an allowlist and payload limits.
- Permission callbacks verify the rawfile origin and requested media resource types.
- HTTP accepts only configured `http` or `https` endpoints; realtime accepts only matching `ws` or `wss` endpoints with no embedded credentials.
- Logs contain operation names and stable error codes, never tokens, media payloads, prompts, or model output.

## Configuration

The first production build uses the same service defaults as Electron:

- HTTP root: `http://127.0.0.1:18000`
- Chat model: `cpmo`
- Realtime URL: `ws://127.0.0.1:18000/v1/realtime`
- Chat timeout: 120 seconds
- Realtime handshake timeout: 35 seconds
- Realtime output timeout: 130 seconds

These values live in one ArkTS configuration file. Device-side SSH or HDC port forwarding can make the loopback endpoint reach the existing model service without exposing that service to the LAN.

## Failure Semantics

Expected stable failures include `invalid_input`, `permission_denied`, `unsupported`, `source_unavailable`, `frame_too_large`, `network_error`, `timeout`, `invalid_response`, `not_ready`, `input_busy`, `protocol_order`, `backpressure`, and `connection_closed`.

System error `801` maps to `unsupported`. Permission error `201` maps to `permission_denied`. Other native error details are logged locally but are not sent verbatim to ArkWeb.

The renderer keeps text fallback behavior when chat is unavailable. Realtime and media features stop visibly; they never silently switch to fake remote behavior.

## Verification

Local gates:

- Existing Electron check, unit, and E2E suites remain green.
- A bridge contract test exercises allowlists, envelopes, event routing, native screen handles, and malformed payloads without a device.
- `hvigorw assembleHap` succeeds against HarmonyOS 6.1.0 / API 23.
- The HAP contains current renderer assets and no credentials, build caches, or desktop-only Electron modules.

Target-device smoke gates:

- Packaged page loads and reports bridge readiness.
- CAMERA and MICROPHONE grants/denials both produce correct UI state.
- Display source enumeration and a bounded JPEG frame succeed; window capture either succeeds or reports `unsupported` without breaking display capture.
- `/health` and chat work through the configured loopback tunnel.
- Realtime audio opens, appends, receives text/audio, and closes cleanly; video mode also includes a native screen or ArkWeb camera JPEG.
- Drag, edge snap, focus, and explicit exit work.
- Background/termination closes media and network activity.

## Known Platform Boundary

`WINDOW_TOPMOST` on the installed SDK guarantees ordering only above this application's own windows. A true cross-application global floating layer remains dependent on vendor authorization/ACL and is outside this non-ACL implementation. The product still runs in a frameless floating window where the device permits it, and it reports the topmost limitation honestly.
