# Windows Product Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Windows Floating Pet directly usable, truthfully grounded, backend-agnostic across SSH/direct profiles, restart-safe for non-sensitive preferences, and resilient when competition machines are unavailable.

**Architecture:** Keep renderer networking-free. A new Node supervisor owned by Electron Main manages `frpc.exe`, system OpenSSH, bounded health probes, and an optional fixed remote Chat start template. A versioned JSON config under Electron `userData` stores safe preferences and connection metadata; the renderer receives only validated state and user-safe errors.

**Tech Stack:** Node.js 24, Electron 43, CommonJS modules, Electron IPC/contextBridge, native `child_process`/`net`/`fs`, system OpenSSH, existing `frpc.exe`, Node test runner, Playwright/Electron E2E.

## Global Constraints

- Do not add PowerShell as a product startup dependency; existing PowerShell scripts remain diagnostic-only.
- Do not copy, parse, upload, or persist private keys, Bearer tokens, FRP tokens, or raw media.
- Do not automatically wake a Modelers/HidevLab Space, modify remote ACLs, or kill an unknown remote PID.
- Do not run Chat and Duplex 9B backends simultaneously or hot-switch them.
- Persist only window position, active level, voice, captions, login-start preference, and non-secret profile metadata.
- Never restore session state, DND/presentation mode, media permissions, screen source, conversation, or raw media.
- A failed remote connection must leave the desktop usable in explicit offline/degraded mode.
- All new trust-boundary inputs require bounded validation and stable error codes.
- Preserve unrelated dirty files in the worktree.

## File Map

- Create `desktop/src/config.cjs`: defaults, profile validation, safe user-config load/save, atomic writes.
- Create `desktop/src/model-supervisor.cjs`: direct Node child-process supervisor and profile health state machine.
- Create `desktop/tests/config.test.cjs`: config validation, migration, atomic-write and bounds tests.
- Create `desktop/tests/model-supervisor.test.cjs`: supervisor success and failure state tests using injected fake children/network.
- Modify `desktop/src/main.cjs`: load config, create/stop supervisor, dynamic model endpoints, bounds persistence, login-item setting, connection IPC.
- Modify `desktop/src/preload.cjs`: expose settings/profile/status methods through the existing frozen bridge.
- Modify `desktop/src/core.cjs`: add explicit `ENGAGE` transitions from IDLE/ACTIVE/COOLDOWN.
- Modify `desktop/src/renderer/app.js`: direct click-to-chat, grounded nudge summary, generic fake/offline text, preference synchronization and reconnect actions.
- Modify `desktop/src/renderer/index.html`: model profile/status controls and login-start control in the existing settings panel.
- Modify `desktop/src/renderer/styles.css`: only the layout rules required by the new settings rows and status states.
- Modify `desktop/tests/core.test.cjs`, `desktop/tests/model-client.test.cjs`, and `desktop/tests/e2e.cjs`: focused behavior coverage.
- Modify `desktop/electron-builder.yml`: include new production CommonJS modules in `app.asar`; do not include credentials or `frpc.exe`.
- Modify `desktop/README.md`: document profile schema, Node supervisor behavior, offline boundary, and verification commands.

---

### Task 1: Add Safe User Configuration

**Files:**
- Create: `desktop/src/config.cjs`
- Create: `desktop/tests/config.test.cjs`

**Interfaces:**
- Produces `DEFAULT_USER_CONFIG`, `normalizeUserConfig(value)`, `readUserConfig(filePath, fsImpl)`, `writeUserConfig(filePath, config, fsImpl)`, and `normalizeProfile(value)`.
- `normalizeUserConfig` returns a new object with `version: 1`, `window: { x: number|null, y: number|null }`, `preferences: { activeLevel, voice, captions, openAtLogin }`, `activeProfileId: string`, and `profiles: Record<string, Profile>`.
- `normalizeProfile` accepts only `transport: 'ssh' | 'direct'`, `desiredMode: 'chat' | 'duplex'`, bounded ports `1..65535`, absolute or `~`-relative remote roots, and endpoint protocols `http:`, `https:`, `ws:`, or `wss:`.

- [ ] **Step 1: Write failing config tests.** Add these exact cases to `desktop/tests/config.test.cjs`:

```js
test('malformed config falls back to safe defaults', () => {
  const value = normalizeUserConfig({ preferences: { activeLevel: 'invalid' }, profiles: null });
  assert.equal(value.version, 1);
  assert.equal(value.preferences.activeLevel, 'balanced');
  assert.equal(value.preferences.openAtLogin, false);
  assert.deepEqual(value.profiles, {});
});

test('profile validation rejects shell-shaped paths and unsupported protocols', () => {
  assert.equal(normalizeProfile({ id: 'x', transport: 'ssh', remoteRoot: '/a; rm -rf /' }), null);
  assert.equal(normalizeProfile({ id: 'x', transport: 'direct', httpBase: 'file:///secret' }), null);
});

test('user config write is atomic and readable', async () => {
  const file = path.join(os.tmpdir(), `floating-pet-config-${process.pid}.json`);
  const config = normalizeUserConfig({ preferences: { voice: false } });
  await writeUserConfig(file, config);
  assert.deepEqual(await readUserConfig(file), config);
});
```

- [ ] **Step 2: Run the focused tests and verify failure.**

Run: `node --test tests/config.test.cjs`

Expected: FAIL because `config.cjs` and its exported functions do not exist.

- [ ] **Step 3: Implement the minimal config module.** Use `node:fs/promises`, `node:path`, and `node:os`; write to `${filePath}.tmp-${process.pid}` with UTF-8 JSON, then rename it over the destination. `readUserConfig` returns defaults on `ENOENT`, invalid JSON, or schema failure. Never preserve unknown fields.

- [ ] **Step 4: Run the focused tests and verify success.**

Run: `node --test tests/config.test.cjs`

Expected: all config tests PASS.

- [ ] **Step 5: Commit the isolated configuration change.**

```powershell
git add -- desktop/src/config.cjs desktop/tests/config.test.cjs
git commit -m "feat: persist validated desktop preferences"
```

### Task 2: Implement the Node Model Supervisor

**Files:**
- Create: `desktop/src/model-supervisor.cjs`
- Create: `desktop/tests/model-supervisor.test.cjs`

**Interfaces:**
- `createSupervisor(options)` returns `{ start(), stop(), retry(), getState(), onState(handler) }`.
- `options.profile` is the normalized profile from Task 1.
- `options.spawnImpl(file, args, options)` defaults to `child_process.spawn` and is injected in tests.
- `options.fetchImpl(url, options)` defaults to `globalThis.fetch` and is injected in tests.
- State events are `{ state, code: string|null, health: object|null }` using only the states in the approved spec.
- `getModelEndpoints(profile)` returns `{ endpoint, realtimeEndpoint, model, token }`; token is read only from the existing process environment and is never serialized in state events.

- [ ] **Step 1: Write failing supervisor tests for success, offline, mismatch, and cleanup.** Use `EventEmitter` fake children and a stub fetch; assert these exact outcomes:

```js
test('ssh profile reaches ready after forwarding and chat health', async () => {
  const supervisor = createSupervisor({ profile: sshProfile(), spawnImpl: fakeSpawn(), fetchImpl: readyChatFetch() });
  await supervisor.start();
  assert.equal(supervisor.getState().state, 'ready');
  assert.equal(supervisor.getState().health.mode, 'chat');
});

test('connection reset is user-safe and does not throw through start', async () => {
  const supervisor = createSupervisor({ profile: sshProfile(), spawnImpl: throwingSpawn('ECONNRESET') });
  await supervisor.start();
  assert.equal(supervisor.getState().state, 'connection_reset');
});

test('running duplex service is not killed for a chat profile', async () => {
  const supervisor = createSupervisor({ profile: sshProfile(), fetchImpl: readyDuplexFetch(), spawnImpl: fakeSpawn() });
  await supervisor.start();
  assert.equal(supervisor.getState().state, 'mode_mismatch');
  assert.equal(fakeChildren().every((child) => child.killCount === 0), true);
});

test('stop kills only local children', async () => {
  const supervisor = createSupervisor({ profile: sshProfile(), spawnImpl: fakeSpawn(), fetchImpl: readyChatFetch() });
  await supervisor.start();
  await supervisor.stop();
  assert.equal(fakeChildren().every((child) => child.killed), true);
});
```

- [ ] **Step 2: Run the focused tests and verify failure.**

Run: `node --test tests/model-supervisor.test.cjs`

Expected: FAIL because the supervisor module is absent.

- [ ] **Step 3: Implement profile and child validation.** Resolve `frpc.exe` only inside `credentialDir`; resolve `sshConfig` relative to that directory; detect `ssh.exe` from an explicit profile path or `where.exe ssh.exe`; reject missing files before spawning. Use argument arrays for local process invocation.

- [ ] **Step 4: Implement the bounded state machine.** Probe an already-ready direct endpoint first. For SSH, start FRP, wait for its configured visitor port with `net.createConnection`, start `ssh -N -L local:remoteHost:remotePort`, and poll `/health`. If health is not ready and `remoteRoot` is present, run only the fixed Chat start template through a short-lived SSH command, then poll again. Enforce per-phase timeouts and emit `connection_refused`, `connection_reset`, `health_timeout`, `remote_start_failed`, or `mode_mismatch` without throwing unhandled errors.

- [ ] **Step 5: Implement stop/retry semantics.** `stop()` terminates the tunnel first, then FRP, waits a bounded interval, and never sends a remote stop command. `retry()` calls `stop()` followed by one `start()`; concurrent starts collapse to one promise.

- [ ] **Step 6: Run the focused tests and verify success.**

Run: `node --test tests/model-supervisor.test.cjs`

Expected: all supervisor tests PASS.

- [ ] **Step 7: Commit the isolated supervisor change.**

```powershell
git add -- desktop/src/model-supervisor.cjs desktop/tests/model-supervisor.test.cjs
git commit -m "feat: supervise configurable model connections"
```

### Task 3: Wire Main, Preload, and Dynamic Model Endpoints

**Files:**
- Modify: `desktop/src/main.cjs`
- Modify: `desktop/src/preload.cjs`
- Modify: `desktop/tests/model-client.test.cjs`

**Interfaces:**
- Main exposes `settings:get`, `settings:update`, `model:connection-state`, `model:connect`, `model:select-profile`, and `model:select-credentials` through trusted IPC only.
- Preload exposes frozen `window.pet.settings.get/update`, `window.pet.model.connect/selectProfile/selectCredentials/onConnectionState` methods.
- Main keeps `activeProfile`, `activeModelConfig`, and one supervisor instance; model and realtime handlers read those values instead of startup-only environment constants.

- [ ] **Step 1: Add failing endpoint/profile tests.** Extend `desktop/tests/model-client.test.cjs` with a profile whose HTTP and WebSocket endpoints differ from `127.0.0.1:18000`; assert the normalized request URL and model name come from the profile while the token is not present in connection-state payloads.

- [ ] **Step 2: Run the focused tests and verify failure.**

Run: `node --test tests/model-client.test.cjs`

Expected: FAIL because the dynamic profile-to-endpoint path is not wired.

- [ ] **Step 3: Load user config before creating the window.** In `app.whenReady()`, read `app.getPath('userData')/config.json`, choose the active profile, clamp saved bounds to `screen.getAllDisplays()`, and call `app.setLoginItemSettings({ openAtLogin })` only when `app.isPackaged && !TEST_MODE`.

- [ ] **Step 4: Register supervisor IPC and state forwarding.** Start the supervisor after the window/tray exists; forward only `{ state, code, health: boundedHealth }` to the renderer. `model:connect` calls `retry()`. Profile updates validate through `config.cjs`, persist atomically, stop the old supervisor, and start the new one. The credential picker returns only a selected directory path after checking for `frpc_visitor.toml`, `ssh_config`, and a private-key filename.

- [ ] **Step 5: Make model handlers use the active profile.** Build the existing Chat and Realtime config objects from `getModelEndpoints(activeProfile)` on each request. Preserve existing request validation, timeout bounds, cancellation, and capability normalization.

- [ ] **Step 6: Persist bounds and stop local children.** Save bounds after drag/snap completion and in `before-quit`; await supervisor stop during `will-quit` with a bounded fallback so Electron cannot hang on a dead child.

- [ ] **Step 7: Run focused tests and the existing smoke gates.**

Run: `node --test tests/model-client.test.cjs tests/realtime-client.test.cjs`

Expected: all existing model/realtime tests PASS; no endpoint or token value appears in returned error/status objects.

- [ ] **Step 8: Commit the Main/Preload integration.**

```powershell
git add -- desktop/src/main.cjs desktop/src/preload.cjs desktop/tests/model-client.test.cjs
git commit -m "feat: connect desktop app to model profiles"
```

### Task 4: Add Direct Engagement and Grounded Renderer Behavior

**Files:**
- Modify: `desktop/src/core.cjs`
- Modify: `desktop/src/renderer/app.js`
- Modify: `desktop/tests/core.test.cjs`

**Interfaces:**
- `transition` accepts `ACTIVE:ENGAGE`, `COOLDOWN:ENGAGE`, and the renderer performs `IDLE:START` followed by `ACTIVE:ENGAGE`.
- Renderer stores `latestObservationSummary: string|null`; `recordObservation` updates it from the validated observation; `resetTransient` clears it.

- [ ] **Step 1: Write failing reducer tests.** Add tests asserting ACTIVE and COOLDOWN engagement becomes ENGAGED, IDLE remains invalid for direct `ENGAGE`, and existing illegal transitions still throw.

- [ ] **Step 2: Run the focused reducer tests and verify failure.**

Run: `node --test tests/core.test.cjs`

Expected: FAIL on the new engagement cases.

- [ ] **Step 3: Implement the two reducer cases.** Keep active inputs and suppression fields unchanged; only change `phase` to `ENGAGED` and clear no conversation data.

- [ ] **Step 4: Change `activatePet`.** For IDLE, call `startSession()` then open the assist panel; for ACTIVE/COOLDOWN, dispatch `ENGAGE` and open it; for ENGAGED, focus the existing card. Keep NUDGE acceptance explicit.

- [ ] **Step 5: Remove fixture-specific assistant text.** Replace the `task.steps` message in `acceptNudge` with a neutral message containing the validated observation summary (or a generic “我看到一个重复线索，可以一起看看。” when no summary exists). Change Fake Adapter replies to generic offline text while preserving `/fail` error semantics.

- [ ] **Step 6: Run focused tests and verify success.**

Run: `node --test tests/core.test.cjs tests/model-client.test.cjs`

Expected: all reducer, fake reply, and model degradation tests PASS; `rg -n "task\\.steps|map 无法" desktop/src` returns no matches.

- [ ] **Step 7: Commit the renderer behavior change.**

```powershell
git add -- desktop/src/core.cjs desktop/src/renderer/app.js desktop/tests/core.test.cjs desktop/tests/model-client.test.cjs
git commit -m "feat: allow direct grounded conversations"
```

### Task 5: Add Settings UI, Persistence Sync, and Reconnect Controls

**Files:**
- Modify: `desktop/src/renderer/index.html`
- Modify: `desktop/src/renderer/styles.css`
- Modify: `desktop/src/renderer/app.js`
- Modify: `desktop/tests/e2e.cjs`

**Interfaces:**
- Existing settings panel gains a model connection group with profile selector, connection status, reconnect button, credential-directory picker, remote-root field, and login-start switch.
- Renderer calls `api.settings.update({ preferences, window })` only with the allowlisted fields from Task 1; it never sends media state or secrets.

- [ ] **Step 1: Extend the Fake E2E with failing assertions.** Assert that clicking an active pet opens `#assistCard`, accepting a nudge displays the server-provided summary, `task.steps` is absent, and a second Electron launch restores the selected active level/voice/captions and a clamped position while all three input toggles are unchecked.

- [ ] **Step 2: Run the focused E2E and verify failure.**

Run: `npm run test:e2e`

Expected: FAIL on the new selectors/behavior before the UI and persistence bridge are implemented.

- [ ] **Step 3: Add the model connection settings group.** Reuse existing surface/setting-row styles; add accessible labels, a status `role=status`, and a reconnect button. Do not add a new UI framework or dependency.

- [ ] **Step 4: Hydrate settings before the first render.** Apply returned safe preferences, selected profile, and window-independent UI state; leave media controls unchecked. Call `api.settings.update` after each preference change and after a successful profile edit.

- [ ] **Step 5: Wire profile switching and reconnect.** Show only user-safe connection states; on reconnect call `api.model.connect()` and `refreshModelCapabilities(true)`. On unavailable profiles show offline fallback instead of disabling the whole assist card.

- [ ] **Step 6: Wire login-start and keyboard behavior.** Reflect the stored switch, keep Escape/Enter behavior intact, and ensure user-initiated text remains enabled under DND/presentation. Do not auto-start any input stream.

- [ ] **Step 7: Run E2E and accessibility smoke checks.**

Run: `npm run test:e2e`

Expected: all existing E2E flows plus the new direct-chat, summary, persistence, reconnect, and no-media-restore assertions PASS.

- [ ] **Step 8: Commit the UI and persistence sync.**

```powershell
git add -- desktop/src/renderer/index.html desktop/src/renderer/styles.css desktop/src/renderer/app.js desktop/tests/e2e.cjs
git commit -m "feat: add reconnectable model settings"
```

### Task 6: Package, Document, and Verify the Complete Closure

**Files:**
- Modify: `desktop/electron-builder.yml`
- Modify: `desktop/README.md`
- Verify: `desktop/scripts/verify-package.mjs`

- [ ] **Step 1: Add the new production modules to the builder file list.** Include `src/config.cjs` and `src/model-supervisor.cjs`; keep tests, credential directories, and FRP binaries outside the packaged app.

- [ ] **Step 2: Update the README.** Document the generic profile fields, direct-vs-SSH transport, Node supervisor states, remote service retention on app exit, login-start default, and the fact that an inaccessible competition machine produces offline mode. Remove any instruction that presents PowerShell as the product startup path.

- [ ] **Step 3: Run all local gates.**

Run from `desktop`:

```powershell
npm run check
npm run test:unit
npm run test:e2e
npm run test:service
npm run test:integration
```

Expected: every command exits `0`; E2E includes direct engagement and persistence coverage.

- [ ] **Step 4: Build and inspect the current package.**

Run: `npm run package`

Expected: fresh NSIS, Portable, and ZIP artifacts are written to `desktop/release` with the current source hash.

- [ ] **Step 5: Verify the package contents.**

Run: `npm run verify:package`

Expected: PASS; `app.asar` contains the two new CommonJS modules and contains no tests, scripts, credentials, or raw media fixtures.

- [ ] **Step 6: Run production-mode fake smoke and record the result.**

Run: `$report = Join-Path $env:TEMP ('floating-pet-smoke-' + [guid]::NewGuid().ToString('N') + '.json'); & .\\node_modules\\.bin\\electron.cmd . --fake-model --smoke-report $report; Get-Content -Raw -LiteralPath $report`

Expected: transparent, always-on-top, skip-taskbar, click-through initialization, no media before session start, and clean exit.

- [ ] **Step 7: Commit packaging and documentation.**

```powershell
git add -- desktop/electron-builder.yml desktop/README.md
git commit -m "chore: package configurable Windows desktop product"
```

## Self-Review Checklist

- Every approved design section maps to at least one task: interaction (Task 4/5), grounded summary (Task 4/5), generic profiles and Node supervisor (Task 2/3), persistence/login startup (Task 1/3/5), failure states and acceptance (Task 2/6).
- No task introduces a PowerShell runtime dependency, a second model backend, or persisted media/credentials.
- Profile-to-endpoint names are consistent: `httpBase`, `realtimeUrl`, `desiredMode`, `remoteRoot`.
- Supervisor states are identical in the design and test plan.
- The plan does not claim real Modelers/HidevLab acceptance before those external machines become reachable.
