(function exposeCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FloatingPetCore = api;
})(typeof globalThis === 'object' ? globalThis : this, function createCore() {
  'use strict';

const PHASES = Object.freeze({
  IDLE: 'IDLE_VISIBLE',
  ACTIVE: 'SESSION_ACTIVE',
  PENDING: 'CUE_PENDING',
  NUDGE: 'NUDGE',
  ENGAGED: 'ENGAGED',
  COOLDOWN: 'COOLDOWN'
});
const SCREEN_OBSERVATION_WINDOW_MS = 180000;

function initialState() {
  return {
    phase: PHASES.IDLE,
    activeInputs: [],
    seenEventKeys: [],
    currentEventKey: null,
    cooldownUntilMs: 0,
    dnd: false,
    presentationMode: false
  };
}

function transition(state, event) {
  const next = { ...state, activeInputs: [...state.activeInputs], seenEventKeys: [...state.seenEventKeys] };
  if (event.type === 'FAULT' || event.type === 'END') return initialState();
  switch (`${state.phase}:${event.type}`) {
    case `${PHASES.IDLE}:START`:
      next.phase = PHASES.ACTIVE;
      return next;
    case `${PHASES.ACTIVE}:INPUT_STARTED`:
    case `${PHASES.PENDING}:INPUT_STARTED`:
    case `${PHASES.NUDGE}:INPUT_STARTED`:
    case `${PHASES.ENGAGED}:INPUT_STARTED`:
    case `${PHASES.COOLDOWN}:INPUT_STARTED`:
      if (!next.activeInputs.includes(event.kind)) next.activeInputs.push(event.kind);
      return next;
    case `${PHASES.ACTIVE}:INPUT_STOPPED`:
    case `${PHASES.PENDING}:INPUT_STOPPED`:
    case `${PHASES.NUDGE}:INPUT_STOPPED`:
    case `${PHASES.ENGAGED}:INPUT_STOPPED`:
    case `${PHASES.COOLDOWN}:INPUT_STOPPED`:
      next.activeInputs = next.activeInputs.filter((kind) => kind !== event.kind);
      return next;
    case `${PHASES.ACTIVE}:CUES_READY`:
      next.phase = PHASES.PENDING;
      next.currentEventKey = event.eventKey;
      return next;
    case `${PHASES.ACTIVE}:ENGAGE`:
    case `${PHASES.COOLDOWN}:ENGAGE`:
      next.phase = PHASES.ENGAGED;
      return next;
    case `${PHASES.PENDING}:SHOW_NUDGE`:
      next.phase = PHASES.NUDGE;
      return next;
    case `${PHASES.NUDGE}:ACCEPT`:
      next.phase = PHASES.ENGAGED;
      if (next.currentEventKey && !next.seenEventKeys.includes(next.currentEventKey)) next.seenEventKeys.push(next.currentEventKey);
      return next;
    case `${PHASES.NUDGE}:DISMISS`:
      next.phase = PHASES.COOLDOWN;
      next.cooldownUntilMs = event.atMs + 600000;
      if (next.currentEventKey && !next.seenEventKeys.includes(next.currentEventKey)) next.seenEventKeys.push(next.currentEventKey);
      next.currentEventKey = null;
      return next;
    case `${PHASES.ENGAGED}:FINISH`:
      next.phase = PHASES.COOLDOWN;
      next.cooldownUntilMs = event.atMs + 120000;
      next.currentEventKey = null;
      return next;
    case `${PHASES.COOLDOWN}:EXPIRE`:
      next.phase = PHASES.ACTIVE;
      return next;
    case `${PHASES.ACTIVE}:SET_DND`:
    case `${PHASES.ENGAGED}:SET_DND`:
    case `${PHASES.COOLDOWN}:SET_DND`:
      next.dnd = Boolean(event.value);
      return next;
    case `${PHASES.ACTIVE}:SET_PRESENTATION`:
    case `${PHASES.ENGAGED}:SET_PRESENTATION`:
    case `${PHASES.COOLDOWN}:SET_PRESENTATION`:
      next.presentationMode = Boolean(event.value);
      return next;
    default:
      throw new Error(`invalid transition: ${state.phase}/${event.type}`);
  }
}

function decideNudge({ phase, activeLevel = 'balanced', dnd, presentationMode, cooldownUntilMs, seenEventKeys, observations, nowMs }) {
  if (phase !== PHASES.ACTIVE || activeLevel === 'quiet' || dnd || presentationMode || nowMs < cooldownUntilMs) return { action: 'suppress', reason: 'global_gate' };
  const eligible = observations
    .filter((item) => item.source !== 'camera' && item.eventKey && !seenEventKeys.includes(item.eventKey))
    .sort((a, b) => a.observedAtMs - b.observedAtMs);
  const keys = [...new Set(eligible.map((item) => item.eventKey))].sort();
  for (const eventKey of keys) {
    const rows = eligible.filter((item) => item.eventKey === eventKey && nowMs - item.observedAtMs <= SCREEN_OBSERVATION_WINDOW_MS);
    const taskComplete = activeLevel === 'active' && rows.length === 1 && rows[0].kind === 'task_complete' && rows[0].source === 'timer';
    const missingRequirement = rows.length === 1 && rows[0].kind === 'missing_requirement';
    const repeated = rows.length >= 2 && rows.at(-1).observedAtMs - rows[0].observedAtMs >= 5000;
    if (taskComplete || missingRequirement || repeated) return {
      action: 'nudge',
      eventKey,
      reason: taskComplete ? 'task_complete' : missingRequirement ? 'missing_requirement' : 'two_observations'
    };
  }
  return { action: 'suppress', reason: 'insufficient_evidence' };
}

function nudgePrompt(kind) {
  if (kind === 'repeated_attempt') return '这个操作似乎重复了几次，需要我一起看看吗？';
  if (kind === 'missing_requirement') return '当前页面似乎少了一项要求，需要我一起补上吗？';
  return '这个错误似乎重复出现，需要我一起看看吗？';
}

function fakeReply(input, turn) {
  const text = String(input || '').trim();
  if (!text) return { ok: false, code: 'empty_input', message: '请输入一句话。' };
  if (text === '/fail') return { ok: false, code: 'fake_backend_error', message: '本机离线回应暂不可用，已保留文字输入。' };
  if (turn > 1) return { ok: true, text: '这是本机离线回应。我保留了本轮文字上下文，可以继续说明你想处理的问题。' };
  return { ok: true, text: '这是本机离线回应。请继续描述当前问题，模型服务恢复后可以获得完整回答。' };
}

  return { PHASES, initialState, transition, decideNudge, nudgePrompt, fakeReply };
});
