# Memory and Focus Timer Design

Date: 2026-08-20  
Status: Design approved in conversation; awaiting written-spec review

## Goal

Add three bounded Windows Electron capabilities:

- view, edit, and delete confirmed memories;
- persist user-confirmed form of address, goals, and preferences;
- run a focus timer that can continue across app restarts.

HarmonyOS is out of scope for this change.

## Decisions

### Explicit confirmation

Only an explicit renderer-local `记住：...` command can create a pending memory. Ordinary conversation, model output, proactive screen analysis, audio, video, and transcripts never create memories. The UI displays the parsed text and category, and writes it only after the user clicks the confirmation action.

The initial parser accepts the three fixed categories (`称呼`, `目标`, `偏好`) and a short text value. It does not infer a category from arbitrary model output. Invalid, empty, or overlong input is rejected locally.

### Memory storage

Memories are stored in the existing versioned Electron `userConfig` file and use the existing `settings:get` / `settings:update` IPC boundary and atomic write path. Each record is:

```js
{
  id: string,
  kind: 'name' | 'goal' | 'preference',
  text: string,
  createdAt: number,
  updatedAt: number
}
```

The normalized list is bounded at 50 records and each text value has a fixed maximum length. Invalid records are discarded during config normalization. No raw media, complete conversations, credentials, or psychological labels are persisted.

The settings panel lists all records and supports inline text/category editing, save, and delete. Deleting a record updates the same config immediately. The empty state is explicit. Memory content is included only in user-initiated text Chat context, as a short bounded block; it is not added to proactive screen analysis or an already-established Duplex stream.

### Focus timer

The timer is a renderer control using the existing settings/persistence path. The default duration is 25 minutes; the input accepts 5 through 120 minutes. Controls are start, pause, resume, and cancel.

Only durable state is stored:

- running: `durationMs` and absolute `endsAt`;
- paused: `durationMs` and `remainingMs`;
- idle: no timer record.

The renderer calculates remaining time from `Date.now()`, so sleep and throttling do not cause drift. On restart, a running timer is reconstructed from `endsAt`; an expired timer transitions to completion. Interval handles are never persisted.

Completion reuses the existing `timer-done` observation and task-complete nudge path. The existing voice setting controls model-generated spoken feedback, and DND/presentation mode continues to suppress speech. No new OS notification permission or background service is added.

## Data flow and boundaries

1. Renderer recognizes an explicit remember command and renders a pending confirmation.
2. User confirms; renderer sends a validated settings patch through the existing preload bridge.
3. Main process normalizes and atomically persists the patch, then returns public settings.
4. Renderer updates its local state and settings UI.
5. User Chat requests receive a bounded projection of confirmed memories; other model paths do not.
6. Timer actions update durable state through the same settings update path. A renderer clock drives display and emits one completion observation.

The main process remains the trust boundary for config shape, limits, and atomic writes. Renderer state is treated as untrusted input. Memory text is data only and cannot trigger tools or side effects.

## Failure handling

- Malformed or oversized memory/timer data falls back to normalized defaults without preventing app startup.
- Persistence failures leave the current in-memory state unchanged and surface an actionable error in the existing settings/assist UI.
- Duplicate completion events are suppressed by clearing the durable running state before emitting the completion observation.
- Delete and edit operate by stable `id`; stale updates are rejected or re-normalized rather than applying to a different record.

## Verification

Add focused tests for:

- config round-trip, bounds, malformed-record cleanup, and timer state validation;
- explicit confirmation requirement and rejection of ordinary chat text;
- memory add/edit/delete and persistence after reload;
- timer start, pause/resume, cancel, completion, sleep/restart calculation, and duplicate-completion suppression;
- memory injection only into user-initiated text Chat and removal after delete;
- existing DND/presentation voice suppression on timer completion.

Run the repository's existing check, unit, service, integration, and Electron E2E gates after the focused tests.

## Deliberate v1 exclusions

- model-based automatic memory extraction;
- free-form memory categories;
- memory injection into Duplex sessions or proactive screen analysis;
- OS notifications, a background timer process, or a new database;
- synchronization across devices.

