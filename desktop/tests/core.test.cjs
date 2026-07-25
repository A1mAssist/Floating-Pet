'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PHASES, initialState, transition, decideNudge, fakeReply } = require('../src/core.cjs');

test('session reducer follows the visible product loop', () => {
  let state = initialState();
  state = transition(state, { type: 'START' });
  state = transition(state, { type: 'INPUT_STARTED', kind: 'screen' });
  state = transition(state, { type: 'CUES_READY', eventKey: 'repeat-map-error' });
  assert.equal(state.phase, PHASES.PENDING);
  state = transition(state, { type: 'SHOW_NUDGE' });
  assert.equal(state.phase, PHASES.NUDGE);
  state = transition(state, { type: 'ACCEPT' });
  assert.equal(state.phase, PHASES.ENGAGED);
  assert.deepEqual(state.seenEventKeys, ['repeat-map-error']);
  state = transition(state, { type: 'FINISH', atMs: 30000 });
  assert.equal(state.phase, PHASES.COOLDOWN);
  assert.equal(state.cooldownUntilMs, 150000);
  state = transition(state, { type: 'END' });
  assert.deepEqual(state, initialState());
});

test('illegal transition fails closed', () => {
  assert.throws(() => transition(initialState(), { type: 'ACCEPT' }), /invalid transition/);
});

test('session reducer preserves input and suppression state', () => {
  let state = transition(initialState(), { type: 'START' });
  state = transition(state, { type: 'INPUT_STARTED', kind: 'microphone' });
  state = transition(state, { type: 'SET_DND', value: true });
  state = transition(state, { type: 'SET_PRESENTATION', value: true });
  assert.deepEqual(state.activeInputs, ['microphone']);
  assert.equal(state.dnd, true);
  assert.equal(state.presentationMode, true);
  state = transition(state, { type: 'INPUT_STOPPED', kind: 'microphone' });
  assert.deepEqual(state.activeInputs, []);
});

test('two screen observations separated by real inference latency allow one nudge', () => {
  const input = {
    phase: PHASES.ACTIVE,
    activeLevel: 'balanced',
    dnd: false,
    presentationMode: false,
    cooldownUntilMs: 0,
    seenEventKeys: [],
    nowMs: 120000,
    observations: [
      { eventKey: 'x', source: 'screen', observedAtMs: 60000 },
      { eventKey: 'x', source: 'screen', observedAtMs: 120000 }
    ]
  };
  assert.deepEqual(decideNudge(input), { action: 'nudge', eventKey: 'x', reason: 'two_observations' });
  assert.equal(decideNudge({ ...input, seenEventKeys: ['x'] }).action, 'suppress');
  assert.equal(decideNudge({ ...input, dnd: true }).action, 'suppress');
  assert.equal(decideNudge({ ...input, activeLevel: 'quiet' }).action, 'suppress');
  assert.equal(decideNudge({ ...input, observations: input.observations.slice(0, 1) }).action, 'suppress');
  assert.equal(decideNudge({ ...input, nowMs: 300001 }).action, 'suppress');
});

test('active level permits one low-risk timer completion', () => {
  const input = {
    phase: PHASES.ACTIVE,
    activeLevel: 'active',
    dnd: false,
    presentationMode: false,
    cooldownUntilMs: 0,
    seenEventKeys: [],
    nowMs: 10000,
    observations: [{ eventKey: 'timer-done', kind: 'task_complete', source: 'timer', observedAtMs: 10000 }]
  };
  assert.deepEqual(decideNudge(input), { action: 'nudge', eventKey: 'timer-done', reason: 'task_complete' });
  assert.equal(decideNudge({ ...input, activeLevel: 'balanced' }).action, 'suppress');
});

test('camera-only observations cannot drive proactive policy', () => {
  const decision = decideNudge({
    phase: PHASES.ACTIVE,
    activeLevel: 'balanced',
    dnd: false,
    presentationMode: false,
    cooldownUntilMs: 0,
    seenEventKeys: [],
    nowMs: 10000,
    observations: [
      { eventKey: 'emotion', source: 'camera', observedAtMs: 4000 },
      { eventKey: 'emotion', source: 'camera', observedAtMs: 10000 }
    ]
  });
  assert.equal(decision.action, 'suppress');
});

test('fake adapter has deterministic success and truthful failure', () => {
  assert.equal(fakeReply('steps 为什么报错', 1).ok, true);
  assert.deepEqual(fakeReply('/fail', 1), {
    ok: false,
    code: 'fake_backend_error',
    message: '演示模型暂不可用，已保留文字输入。'
  });
});
