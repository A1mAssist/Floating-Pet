# Memory and Focus Timer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add confirmed memory CRUD and a restart-safe focus timer to the Windows Electron pet while preserving the existing config, IPC, Chat, and nudge paths.

**Architecture:** Extend the existing normalized `userConfig` with bounded `memories` and a compact `focusTimer` record. Reuse `settings:update`; the renderer owns pending confirmation, CRUD controls, timer display, and absolute-time calculation. Inject a bounded memory projection only into user-initiated text Chat requests.

**Tech Stack:** Electron 43, vanilla renderer JavaScript, HTML/CSS, Node `node:test`, Playwright E2E.

## Global Constraints

- HarmonyOS is out of scope.
- Only explicit `记住：...` input can create a pending memory; confirmation is required before persistence.
- Fixed memory kinds are `name | goal | preference`; maximum 50 records and bounded text.
- Raw media, complete conversations, credentials, and psychological labels never persist.
- Running timers persist `durationMs` and `endsAt`; paused timers persist `durationMs` and `remainingMs`; interval handles never persist.
- Timer completion reuses `timer-done` and existing task-complete nudge behavior; no OS notification or background service.
- Use existing IPC and persistence helpers; do not add dependencies or a second storage file.
- Renderer input is untrusted; main-process normalization remains the config trust boundary.

## Files And Responsibilities

- Modify `desktop/src/config.cjs`: normalize defaults and bounded memory/timer records.
- Modify `desktop/src/main.cjs`: accept validated `memories` and `focusTimer` settings patches through `settings:update`.
- Modify `desktop/src/renderer/index.html`: add memory and focus controls to existing settings/assist surfaces.
- Modify `desktop/src/renderer/styles.css`: style the new rows and compact timer without changing the window layout model.
- Modify `desktop/src/renderer/app.js`: pending confirmation, memory CRUD, Chat projection, timer state machine, persistence, rendering, and test hooks.
- Modify `desktop/tests/config.test.cjs`: config normalization and round-trip tests.
- Modify `desktop/tests/e2e.cjs`: confirmation, CRUD/relaunch, Chat projection, timer lifecycle, and completion tests.

### Task 1: Normalize Durable Data

**Files:**
- Modify: `desktop/src/config.cjs`
- Test: `desktop/tests/config.test.cjs`

**Interfaces:**
- Produce `normalizeMemory(value)` and `normalizeFocusTimer(value)` internal helpers.
- Extend `normalizeUserConfig(value)` to return `memories: []` and `focusTimer: null | { state, durationMs, endsAt?, remainingMs? }`.

- [ ] **Step 1: Write failing config tests**

```js
test('normalizes bounded memories and restart-safe focus timer', () => {
  const value = normalizeUserConfig({
    memories: [
      { id: 'm-1', kind: 'name', text: '叫我小林', createdAt: 1, updatedAt: 2 },
      { id: '', kind: 'goal', text: 'bad', createdAt: 1, updatedAt: 2 },
      { id: 'm-2', kind: 'nope', text: 'bad', createdAt: 1, updatedAt: 2 }
    ],
    focusTimer: { state: 'running', durationMs: 1500000, endsAt: 1700000000000, remainingMs: 1 }
  });
  assert.deepEqual(value.memories, [{ id: 'm-1', kind: 'name', text: '叫我小林', createdAt: 1, updatedAt: 2 }]);
  assert.deepEqual(value.focusTimer, { state: 'running', durationMs: 1500000, endsAt: 1700000000000 });
});

test('drops oversized memories and invalid timer states', () => {
  const value = normalizeUserConfig({
    memories: [{ id: 'm-1', kind: 'goal', text: 'x'.repeat(501), createdAt: 1, updatedAt: 1 }],
    focusTimer: { state: 'running', durationMs: 1, endsAt: 0 }
  });
  assert.deepEqual(value.memories, []);
  assert.equal(value.focusTimer, null);
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `node --test desktop/tests/config.test.cjs --test-name-pattern="normalizes bounded memories|drops oversized"`  
Expected: FAIL because the new normalized fields are not present.

- [ ] **Step 3: Implement minimal normalization**

Add fixed constants (`MAX_MEMORIES = 50`, `MAX_MEMORY_TEXT = 500`, duration bounds `5 * 60 * 1000` through `120 * 60 * 1000`), UUID-safe bounded IDs, timestamp checks, and state-specific field selection. Add `memories` and `focusTimer` to `DEFAULT_USER_CONFIG` and the normalized return object. Do not copy unknown fields.

- [ ] **Step 4: Run config tests**

Run: `npm --prefix desktop test:unit`  
Expected: PASS, including existing profile and secret-dropping tests.

- [ ] **Step 5: Commit**

```text
git add desktop/src/config.cjs desktop/tests/config.test.cjs
git commit -m "feat: normalize memories and focus timer state"
```

### Task 2: Extend The Existing Settings Boundary

**Files:**
- Modify: `desktop/src/main.cjs`

**Interfaces:**
- Consume `patch.memories` and `patch.focusTimer` in `updateSettingsNow(patch)`.
- Produce the same `{ ok: true, settings }` response already returned by `settings:update`.

- [ ] **Step 1: Add main-process rejection tests in the existing E2E harness**

Use `window.pet.settings.update({ memories: [{ ... }] })` and assert the normalized public settings contains only allowed fields; send an invalid kind and assert `{ ok: false, code: 'invalid_settings' }`.

- [ ] **Step 2: Run the targeted E2E test to confirm the current boundary rejects the patch**

Run: `node --test desktop/tests/e2e.cjs --test-name-pattern="settings"`  
Expected: the new assertion fails until `updateSettingsNow` handles the two fields.

- [ ] **Step 3: Implement the smallest patch handling**

When `patch.memories` is present, require an array and assign it to `next.memories`; when `patch.focusTimer` is present, accept `null` or an object. Let `normalizeUserConfig(next)` enforce record limits and field shape, but reject non-array/non-object patch containers with `invalid_settings`. Keep existing profile reconnect behavior unchanged.

- [ ] **Step 4: Run settings and config tests**

Run: `npm --prefix desktop test:unit` and the focused E2E test.  
Expected: PASS with malformed values normalized or rejected at the trust boundary.

- [ ] **Step 5: Commit**

```text
git add desktop/src/main.cjs desktop/tests/e2e.cjs
git commit -m "feat: persist memory and timer settings through existing IPC"
```

### Task 3: Add Memory Confirmation, CRUD, And Chat Projection

**Files:**
- Modify: `desktop/src/renderer/index.html`
- Modify: `desktop/src/renderer/styles.css`
- Modify: `desktop/src/renderer/app.js`
- Test: `desktop/tests/e2e.cjs`

**Interfaces:**
- Consume `persistedSettings.memories` and `api.settings.update()`.
- Produce a pending explicit-confirmation row, stable-ID edit/delete operations, and a bounded `confirmedMemoryContext()` string for user Chat only.

- [ ] **Step 1: Add failing E2E coverage**

Cover this sequence: open assist, submit ordinary text and assert config memories stay empty; submit `记住：称呼：叫我小林`, assert a visible confirmation control, click confirm, assert one `name` record; edit the text and save; delete it; reload and assert it is still absent. Add a remote Chat stub assertion that the request contains the confirmed-memory block only after confirmation.

- [ ] **Step 2: Run the new E2E test and verify failure**

Run: `node --test desktop/tests/e2e.cjs --test-name-pattern="memory"`  
Expected: FAIL because the controls and parser do not exist.

- [ ] **Step 3: Add the minimal UI**

Add a compact “记忆” group in `settingsPanel` with an empty state and a list container. Each record uses a native select for the three kinds, a bounded text input, a save icon button, and a delete icon button with accessible labels. Add a pending confirmation row near the conversation form with confirm/cancel buttons. Add a compact “专注” control group in the assist card containing duration input, remaining label, start/pause/resume/cancel buttons.

- [ ] **Step 4: Implement local parser and CRUD**

Parse only the prefix `记住：` / `记住:`. Accept `称呼：text`, `目标：text`, or `偏好：text`; reject anything else with a toast. Keep pending data in renderer memory until confirm. On confirm, edit, or delete, call `api.settings.update({ memories })`, apply returned settings, and re-render. Use `crypto.randomUUID()` in the renderer only for a pending ID; main normalization remains authoritative.

- [ ] **Step 5: Implement bounded Chat projection**

Build one short text block from `persistedSettings.memories`, capped below the existing message limit. Prepend it as a `system` message only in `sendMessage()` when `useRemoteChat` is true. Keep proactive screen calls and realtime calls unchanged. Never pass raw config objects to the model.

- [ ] **Step 6: Run focused E2E and existing unit gates**

Run: `node --test desktop/tests/e2e.cjs --test-name-pattern="memory"` and `npm --prefix desktop run test:unit`.  
Expected: PASS; ordinary chat remains non-persistent and deleting a record removes it from the next Chat request.

- [ ] **Step 7: Commit**

```text
git add desktop/src/renderer/index.html desktop/src/renderer/styles.css desktop/src/renderer/app.js desktop/tests/e2e.cjs
git commit -m "feat: add confirmed memory management"
```

### Task 4: Add Restart-Safe Focus Timer

**Files:**
- Modify: `desktop/src/renderer/index.html`
- Modify: `desktop/src/renderer/styles.css`
- Modify: `desktop/src/renderer/app.js`
- Test: `desktop/tests/e2e.cjs`

**Interfaces:**
- Consume normalized `persistedSettings.focusTimer` and `api.settings.update()`.
- Produce start/pause/resume/cancel controls and one `timer-done` observation on expiry.

- [ ] **Step 1: Add failing timer E2E coverage**

Set a 5-minute timer, use the existing test clock hook to advance past `endsAt`, assert the display reaches complete and the completion path emits exactly one timer observation. Assert pause stores `remainingMs`, resume reconstructs `endsAt`, cancel clears persisted state, and a relaunch with a running `endsAt` restores the correct remaining value.

- [ ] **Step 2: Run the timer test and verify failure**

Run: `node --test desktop/tests/e2e.cjs --test-name-pattern="focus timer"`  
Expected: FAIL because timer controls and state are absent.

- [ ] **Step 3: Implement absolute-time state transitions**

Add `focusTimer` renderer state and one 250ms display interval. Start writes `{ state: 'running', durationMs, endsAt: nowMs() + durationMs }`; pause writes `{ state: 'paused', durationMs, remainingMs }`; resume writes a new `endsAt`; cancel writes `null`. On every tick and initialization, if running and `nowMs() >= endsAt`, clear durable state before showing a local completion toast/caption; if the session is active, also emit `{ eventKey: 'timer-done', kind: 'task_complete', source: 'timer', observedAtMs: nowMs() }` through `recordObservation`. Guard completion by state and clear-before-notify so it fires once.

- [ ] **Step 4: Render completion feedback without new services**

Reuse existing nudge/toast/caption behavior and DND/presentation gates. Do not add an OS notification, worker, or background process. Keep the existing model/audio path untouched.

- [ ] **Step 5: Run focused timer E2E and all existing gates**

Run: `node --test desktop/tests/e2e.cjs --test-name-pattern="focus timer"`; then `npm --prefix desktop run test:unit`, `npm --prefix desktop run test:service`, and `npm --prefix desktop run test:integration`.  
Expected: PASS, with exactly one completion event across ticks and restart.

- [ ] **Step 6: Commit**

```text
git add desktop/src/renderer/index.html desktop/src/renderer/styles.css desktop/src/renderer/app.js desktop/tests/e2e.cjs
git commit -m "feat: add restart-safe focus timer"
```

### Task 5: Adversarial Verification And Final Review

**Files:**
- Modify only files needed to fix findings from verification.

- [ ] **Step 1: Run the complete desktop check**

Run: `npm --prefix desktop run check`; `npm --prefix desktop test:unit`; `npm --prefix desktop test:e2e`; `npm --prefix desktop test:service`; `npm --prefix desktop test:integration`.

- [ ] **Step 2: Attack the highest-risk boundaries**

Verify from the persisted config that arbitrary chat text, model responses, screenshots, audio payloads, and credentials are absent; invalid memory IDs cannot edit a different record; deleting a memory removes it from the next Chat request; a timer cannot emit twice after a reload or repeated clock ticks; and DND/presentation mode suppresses completion speech/notification behavior.

- [ ] **Step 3: Review the diff for unnecessary surface area**

Run: `git diff --stat HEAD~4..HEAD` and `git diff --check HEAD~4..HEAD`. Remove unused helpers, duplicated state, and any new dependency before final delivery.

- [ ] **Step 4: Commit fixes and report evidence**

```text
git add desktop/src/config.cjs desktop/src/main.cjs desktop/src/renderer/index.html desktop/src/renderer/styles.css desktop/src/renderer/app.js desktop/tests/config.test.cjs desktop/tests/e2e.cjs
git commit -m "test: harden memory and focus timer boundaries"
```
