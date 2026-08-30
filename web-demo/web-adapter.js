(() => {
  'use strict';

  const STORAGE_KEY = 'floating-pet.web-demo.v1';
  const MAX_FILE_SIZE = 1_000_000;
  const blockedControls = new Set(['micToggle', 'cameraToggle', 'screenToggle', 'screenSource', 'realtimeToggle', 'voiceToggle', 'openAtLoginToggle']);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const isSafeTime = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;

  function defaults() {
    return {
      version: 1,
      window: { x: null, y: null },
      preferences: { activeLevel: 'balanced', voice: false, captions: true, openAtLogin: false },
      activeProfileId: '',
      profiles: {},
      memories: [],
      focusTimer: null,
      todos: [],
      notes: [],
      focusStats: { completed: 0, minutes: 0 }
    };
  }

  function text(value, limit, multiline = false) {
    if (typeof value !== 'string') return null;
    const clean = value.trim();
    const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
    return clean && clean.length <= limit && !controls.test(clean) ? clean : null;
  }

  function uniqueList(value, limit, normalize) {
    if (!Array.isArray(value)) return [];
    const result = [];
    const ids = new Set();
    for (const candidate of value) {
      if (result.length >= limit) break;
      const item = normalize(candidate);
      if (item && !ids.has(item.id)) {
        ids.add(item.id);
        result.push(item);
      }
    }
    return result;
  }

  function normalizeMemory(value) {
    if (!isRecord(value)) return null;
    const id = text(value.id, 100);
    const content = text(value.text, 500);
    if (!id || !content || !['name', 'goal', 'preference'].includes(value.kind)
        || !isSafeTime(value.createdAt) || !isSafeTime(value.updatedAt, value.createdAt)) return null;
    return { id, kind: value.kind, text: content, createdAt: value.createdAt, updatedAt: value.updatedAt };
  }

  function normalizeTodo(value) {
    if (!isRecord(value)) return null;
    const id = text(value.id, 100);
    const content = text(value.text, 240);
    if (!id || !content || typeof value.done !== 'boolean' || !isSafeTime(value.createdAt)) return null;
    const completedAt = value.completedAt == null ? null : isSafeTime(value.completedAt, value.createdAt) ? value.completedAt : null;
    return { id, text: content, done: value.done, createdAt: value.createdAt, completedAt };
  }

  function normalizeNote(value) {
    if (!isRecord(value)) return null;
    const id = text(value.id, 100);
    const content = text(value.text, 2000, true);
    if (!id || !content || !isSafeTime(value.createdAt) || !isSafeTime(value.updatedAt, value.createdAt)) return null;
    return { id, text: content, createdAt: value.createdAt, updatedAt: value.updatedAt };
  }

  function normalizeTimer(value) {
    if (!isRecord(value) || !['running', 'paused'].includes(value.state)) return null;
    const durationMs = Number(value.durationMs);
    if (!Number.isSafeInteger(durationMs) || durationMs < 300_000 || durationMs > 7_200_000) return null;
    if (value.state === 'running') return isSafeTime(value.endsAt, 1) ? { state: 'running', durationMs, endsAt: value.endsAt } : null;
    return Number.isSafeInteger(value.remainingMs) && value.remainingMs >= 0 && value.remainingMs <= durationMs
      ? { state: 'paused', durationMs, remainingMs: value.remainingMs }
      : null;
  }

  function normalizePreferences(value, silent = true) {
    const input = isRecord(value) ? value : {};
    return {
      activeLevel: ['quiet', 'balanced', 'active'].includes(input.activeLevel) ? input.activeLevel : 'balanced',
      voice: silent ? false : typeof input.voice === 'boolean' ? input.voice : true,
      captions: typeof input.captions === 'boolean' ? input.captions : true,
      openAtLogin: silent ? false : typeof input.openAtLogin === 'boolean' ? input.openAtLogin : false
    };
  }

  function normalizeConfig(value) {
    const input = isRecord(value) ? value : {};
    const stats = isRecord(input.focusStats) ? input.focusStats : {};
    return {
      ...defaults(),
      preferences: normalizePreferences(input.preferences),
      memories: uniqueList(input.memories, 50, normalizeMemory),
      focusTimer: normalizeTimer(input.focusTimer),
      todos: uniqueList(input.todos, 100, normalizeTodo),
      notes: uniqueList(input.notes, 30, normalizeNote),
      focusStats: {
        completed: isSafeTime(stats.completed) ? Math.min(stats.completed, 1_000_000) : 0,
        minutes: isSafeTime(stats.minutes) ? Math.min(stats.minutes, 10_000_000) : 0
      }
    };
  }

  function load() {
    try { return normalizeConfig(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')); }
    catch { return defaults(); }
  }

  let settings = load();

  function save(next) {
    const normalized = normalizeConfig(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized)); }
    catch { return { ok: false, code: 'save_failed' }; }
    settings = normalized;
    return { ok: true, settings: clone(settings) };
  }

  function updateSettings(patch) {
    if (!isRecord(patch)) return { ok: false, code: 'invalid_settings' };
    const next = clone(settings);
    if (Object.hasOwn(patch, 'preferences')) {
      if (!isRecord(patch.preferences)) return { ok: false, code: 'invalid_settings' };
      next.preferences = { ...next.preferences, ...patch.preferences, voice: false, openAtLogin: false };
    }
    for (const name of ['memories', 'todos', 'notes']) {
      if (!Object.hasOwn(patch, name)) continue;
      if (!Array.isArray(patch[name])) return { ok: false, code: 'invalid_settings' };
      next[name] = patch[name];
    }
    if (Object.hasOwn(patch, 'focusTimer')) {
      if (patch.focusTimer !== null && !isRecord(patch.focusTimer)) return { ok: false, code: 'invalid_settings' };
      next.focusTimer = patch.focusTimer;
    }
    if (Object.hasOwn(patch, 'focusStats')) {
      if (!isRecord(patch.focusStats)) return { ok: false, code: 'invalid_settings' };
      next.focusStats = patch.focusStats;
    }
    if (Object.hasOwn(patch, 'profile') || Object.hasOwn(patch, 'removeProfileId')) return { ok: false, code: 'invalid_profile' };
    if (Object.hasOwn(patch, 'activeProfileId') && patch.activeProfileId !== '') return { ok: false, code: 'invalid_profile' };
    return save(next);
  }

  function backupData() {
    return {
      version: 1,
      exportedAt: Date.now(),
      preferences: clone(settings.preferences),
      memories: clone(settings.memories),
      todos: clone(settings.todos),
      notes: clone(settings.notes),
      focusStats: clone(settings.focusStats)
    };
  }

  function exportSettings() {
    try {
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(backupData(), null, 2)}\n`], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `floating-pet-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      return { ok: true };
    } catch { return { ok: false, code: 'export_failed' }; }
  }

  function normalizeBackup(value) {
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.preferences)
        || !Array.isArray(value.memories) || !Array.isArray(value.todos) || !Array.isArray(value.notes)
        || !isRecord(value.focusStats)) return null;
    const normalized = {
      preferences: normalizePreferences(value.preferences, false),
      memories: uniqueList(value.memories, 50, normalizeMemory),
      todos: uniqueList(value.todos, 100, normalizeTodo),
      notes: uniqueList(value.notes, 30, normalizeNote),
      focusStats: normalizeConfig({ focusStats: value.focusStats }).focusStats
    };
    const payload = {
      preferences: value.preferences,
      memories: value.memories,
      todos: value.todos,
      notes: value.notes,
      focusStats: value.focusStats
    };
    return JSON.stringify(normalized) === JSON.stringify(payload) ? normalized : null;
  }

  function importSettings() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      const finish = (result) => { input.remove(); resolve(result); };
      input.addEventListener('cancel', () => finish({ ok: false, code: 'cancelled' }), { once: true });
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return finish({ ok: false, code: 'cancelled' });
        if (file.size > MAX_FILE_SIZE) return finish({ ok: false, code: 'invalid_backup' });
        try {
          const imported = normalizeBackup(JSON.parse(await file.text()));
          finish(imported ? save({ ...settings, ...imported }) : { ok: false, code: 'invalid_backup' });
        } catch { finish({ ok: false, code: 'invalid_backup' }); }
      }, { once: true });
      input.click();
    });
  }

  const noOp = () => undefined;
  const unsubscribe = () => noOp;
  const unavailable = () => ({ ok: false, code: 'web_demo_unavailable' });
  const capabilities = Object.freeze({ state: 'fake', mode: 'fake', chatCompletions: true, imageInput: false, chatAudioInput: false, realtime: false, audioInput: false, video: false, audioOutput: false, serviceFake: false, reason: null });

  window.pet = Object.freeze({
    runtime: Object.freeze({ fakeModel: true, demoMode: true, modelLabel: 'Web Demo', testMode: false }),
    window: Object.freeze({ beginDrag: async () => ({ x: 0, y: 0 }), moveDrag: noOp, endDrag: noOp, setClickThrough: noOp, focus: noOp }),
    capture: Object.freeze({ listSources: async () => [{ id: 'web-demo', name: 'Web Demo 演示画面' }], selectSource: async (id) => id === 'web-demo', onShutdown: unsubscribe }),
    settings: Object.freeze({ get: async () => ({ ok: true, settings: clone(settings) }), update: async (patch) => updateSettings(patch), export: async () => exportSettings(), import: importSettings }),
    model: Object.freeze({
      chat: async (request = {}) => {
        const lastUser = [...(Array.isArray(request.messages) ? request.messages : [])].reverse().find((message) => message?.role === 'user');
        const result = window.FloatingPetCore.fakeReply(lastUser?.content || '', request.turn);
        return { ...result, source: 'fake', degraded: false, remoteAttempted: false, visualUsed: false, audioUsed: false };
      },
      capabilities: async () => capabilities,
      analyzeScreen: async () => unavailable(),
      cancelScreenAnalysis: noOp,
      connectionState: async () => ({ state: 'ready', code: null, health: null }),
      connect: async () => ({ state: 'ready', code: null, health: null }),
      selectProfile: async (id) => id === '' ? updateSettings({ activeProfileId: '' }) : { ok: false, code: 'invalid_profile' },
      selectCredentials: async () => unavailable(),
      onConnectionState: unsubscribe
    }),
    realtime: Object.freeze({ start: async () => unavailable(), append: async () => unavailable(), stop: async () => ({ ok: true }), onEvent: unsubscribe }),
    app: Object.freeze({ onCommand: unsubscribe, updateState: noOp, rendererReady: noOp, quit: noOp })
  });

  const rejectCapture = () => Promise.reject(new DOMException('Web Demo does not capture media', 'NotAllowedError'));
  try { Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: rejectCapture }); } catch {}
  try { Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: rejectCapture }); } catch {}
  try {
    window.speechSynthesis?.cancel();
    Object.defineProperty(window.speechSynthesis, 'speak', { configurable: true, value: noOp });
  } catch {}

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const label = target?.closest('label[for]');
    const id = target?.closest('[id]')?.id || label?.htmlFor;
    if (!blockedControls.has(id)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  document.addEventListener('DOMContentLoaded', () => {
    document.title = '浮伴 Floating Pet · Web Demo';
    document.body.dataset.webDemo = 'true';
    const badge = document.createElement('p');
    badge.className = 'web-demo-badge';
    badge.textContent = 'Web Demo · 本地模拟，不连接模型服务';
    document.body.prepend(badge);
    for (const id of blockedControls) {
      const control = document.getElementById(id);
      if (!control) continue;
      control.setAttribute('aria-disabled', 'true');
      control.tabIndex = -1;
    }
    document.querySelector('label[for="voiceToggle"] small').textContent = 'Web Demo 固定静音';
    document.querySelector('label[for="openAtLoginToggle"] small').textContent = '仅桌面版支持';
  }, { once: true });
})();
