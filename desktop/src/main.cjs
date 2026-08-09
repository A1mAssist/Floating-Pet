'use strict';

const { app, BrowserWindow, Menu, Tray, ipcMain, screen: electronScreen, session, desktopCapturer, nativeImage, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeProfile, normalizeUserConfig, readUserConfig, writeUserConfig } = require('./config.cjs');
const { createSupervisor, getModelEndpoints } = require('./model-supervisor.cjs');
const {
  chat: modelChat,
  fakeChat,
  fallbackChat,
  analyzeScreen: modelAnalyzeScreen,
  capabilities: modelCapabilities,
  fakeCapabilities
} = require('./model-client.cjs');
const {
  DEFAULT_REALTIME_OUTPUT_TIMEOUT_MS,
  DEFAULT_REALTIME_TIMEOUT_MS,
  RealtimeClient,
  FakeRealtimeClient
} = require('./realtime-client.cjs');

const ROOT = path.resolve(__dirname, '..');
const TEST_MODE = process.argv.includes('--test-mode');
const FAKE_MODEL = process.argv.includes('--fake-model') || TEST_MODE;
const smokeIndex = process.argv.indexOf('--smoke-report');
const SMOKE_REPORT = smokeIndex >= 0 ? path.resolve(process.argv[smokeIndex + 1] || '') : null;
const WINDOW_SIZE = { width: 460, height: 640 };
const parsedModelTimeout = Number.parseInt(process.env.FLOATING_PET_MODEL_TIMEOUT_MS || '', 10);
const LEGACY_MODEL_CONFIG = Object.freeze({
  endpoint: process.env.FLOATING_PET_MODEL_URL || 'http://127.0.0.1:18000',
  model: process.env.FLOATING_PET_MODEL_NAME || 'cpmo',
  token: process.env.FLOATING_PET_MODEL_TOKEN || '',
  timeoutMs: Number.isInteger(parsedModelTimeout) && parsedModelTimeout >= 1000 && parsedModelTimeout <= 300000 ? parsedModelTimeout : 120000
});
const parsedRealtimeTimeout = Number.parseInt(process.env.FLOATING_PET_REALTIME_TIMEOUT_MS || '', 10);
const parsedRealtimeOutputTimeout = Number.parseInt(process.env.FLOATING_PET_REALTIME_OUTPUT_TIMEOUT_MS || '', 10);
const LEGACY_REALTIME_CONFIG = Object.freeze({
  endpoint: process.env.FLOATING_PET_REALTIME_URL || 'ws://127.0.0.1:18000/v1/realtime',
  timeoutMs: Number.isInteger(parsedRealtimeTimeout) && parsedRealtimeTimeout >= 1000 && parsedRealtimeTimeout <= 300000
    ? parsedRealtimeTimeout
    : DEFAULT_REALTIME_TIMEOUT_MS,
  outputTimeoutMs: Number.isInteger(parsedRealtimeOutputTimeout) && parsedRealtimeOutputTimeout >= 1000 && parsedRealtimeOutputTimeout <= 300000
    ? parsedRealtimeOutputTimeout
    : DEFAULT_REALTIME_OUTPUT_TIMEOUT_MS
});

let mainWindow;
let tray;
let configFilePath = null;
let userConfig = normalizeUserConfig(null);
let activeProfile = null;
let modelSupervisor = null;
let modelSupervisorUnsubscribe = null;
let supervisorOperation = Promise.resolve();
let connectionState = { state: 'idle', code: null, health: null };
let shutdownStarted = false;
let shutdownReady = false;
let lastWindowPosition = { x: null, y: null };
let settingsOperation = Promise.resolve();
let selectedSourceId = null;
let snapTimer = null;
let clickThroughInitialized = false;
let smokeWritten = false;
let latestSnapshot = { phase: 'IDLE_VISIBLE', activeLevel: 'balanced', dnd: false, activeInputs: [] };
let realtimeClient = null;
let realtimeUnsubscribe = null;
let realtimeRequestGeneration = 0;
let realtimeClosePromise = Promise.resolve();
const screenAnalysisControllers = new Map();
let latestRealtimeAppendMeta = null;

function boundedSnapshot(value) {
  const phases = ['IDLE_VISIBLE', 'SESSION_ACTIVE', 'CUE_PENDING', 'NUDGE', 'ENGAGED', 'COOLDOWN'];
  const inputs = ['microphone', 'camera', 'screen'];
  const activeLevels = ['quiet', 'balanced', 'active'];
  if (!value || !phases.includes(value.phase)) return latestSnapshot;
  return {
    phase: value.phase,
    activeLevel: activeLevels.includes(value.activeLevel) ? value.activeLevel : 'balanced',
    dnd: Boolean(value.dnd),
    activeInputs: Array.isArray(value.activeInputs) ? value.activeInputs.filter((kind) => inputs.includes(kind)) : []
  };
}

function isJpegFrame(value) {
  if (typeof value !== 'string' || !value) return false;
  const encoded = value.startsWith('data:image/jpeg;base64,')
    ? value.slice('data:image/jpeg;base64,'.length)
    : value;
  try {
    const bytes = Buffer.from(encoded, 'base64');
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  } catch {
    return false;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function currentModelConfig(signal = null) {
  if (!activeProfile) {
    const config = { ...LEGACY_MODEL_CONFIG, realtimeEndpoint: LEGACY_REALTIME_CONFIG.endpoint };
    return signal ? { ...config, signal } : config;
  }
  const endpoints = getModelEndpoints(activeProfile);
  return {
    endpoint: endpoints.endpoint,
    realtimeEndpoint: endpoints.realtimeEndpoint,
    model: endpoints.model,
    token: endpoints.token,
    timeoutMs: LEGACY_MODEL_CONFIG.timeoutMs,
    ...(signal ? { signal } : {})
  };
}

function currentRealtimeConfig() {
  if (!activeProfile) return LEGACY_REALTIME_CONFIG;
  return {
    endpoint: getModelEndpoints(activeProfile).realtimeEndpoint,
    timeoutMs: LEGACY_REALTIME_CONFIG.timeoutMs,
    outputTimeoutMs: LEGACY_REALTIME_CONFIG.outputTimeoutMs
  };
}

function publicSettings() {
  return normalizeUserConfig(userConfig);
}

function publishConnectionState(value) {
  connectionState = value && typeof value === 'object'
    ? { state: value.state, code: value.code ?? null, health: value.health ?? null }
    : { state: 'idle', code: null, health: null };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('model:connection-state-changed', connectionState);
  }
}

function applyLoginSetting() {
  if (app.isPackaged && !TEST_MODE) {
    try {
      app.setLoginItemSettings({ openAtLogin: userConfig.preferences.openAtLogin });
    } catch {
      // Keep the desktop usable if Windows rejects login-item registration.
    }
  }
}

function reconfigureSupervisor(profile) {
  const run = supervisorOperation.catch(() => {}).then(async () => {
    modelSupervisorUnsubscribe?.();
    modelSupervisorUnsubscribe = null;
    const previous = modelSupervisor;
    modelSupervisor = null;
    if (previous) await previous.stop();
    publishConnectionState({ state: 'idle', code: null, health: null });
    if (!profile || FAKE_MODEL) return connectionState;

    const next = createSupervisor({ profile });
    modelSupervisor = next;
    modelSupervisorUnsubscribe = next.onState((state) => {
      if (modelSupervisor === next) publishConnectionState(state);
    });
    void next.start();
    return next.getState();
  });
  supervisorOperation = run;
  return run;
}

async function stopSupervisor() {
  await settingsOperation.catch(() => {});
  await supervisorOperation.catch(() => {});
  modelSupervisorUnsubscribe?.();
  modelSupervisorUnsubscribe = null;
  const current = modelSupervisor;
  modelSupervisor = null;
  if (current) await current.stop();
}

async function saveUserConfig(next, { reconnect = false } = {}) {
  if (!configFilePath) throw new Error('config_not_ready');
  await writeUserConfig(configFilePath, next);
  userConfig = normalizeUserConfig(next);
  activeProfile = userConfig.profiles[userConfig.activeProfileId] || null;
  applyLoginSetting();
  if (reconnect) {
    realtimeRequestGeneration += 1;
    await closeRealtime('profile_changed');
    cancelScreenAnalyses();
    await reconfigureSupervisor(activeProfile);
  }
  return publicSettings();
}

function sendCommand(command) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:command', command);
}

function rebuildTrayMenu() {
  if (!tray) return;
  const active = latestSnapshot.phase !== 'IDLE_VISIBLE';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: active ? '结束陪伴' : '开始陪伴', click: () => sendCommand('toggle-session') },
    { label: '暂停采集', enabled: latestSnapshot.activeInputs.length > 0, click: () => sendCommand('pause-capture') },
    { label: '勿扰', type: 'checkbox', checked: latestSnapshot.dnd, click: () => sendCommand('toggle-dnd') },
    { label: '主动程度', submenu: [
      { label: '安静', type: 'radio', checked: latestSnapshot.activeLevel === 'quiet', click: () => sendCommand('set-active-level:quiet') },
      { label: '平衡', type: 'radio', checked: latestSnapshot.activeLevel === 'balanced', click: () => sendCommand('set-active-level:balanced') },
      { label: '主动', type: 'radio', checked: latestSnapshot.activeLevel === 'active', click: () => sendCommand('set-active-level:active') }
    ] },
    { type: 'separator' },
    { label: '设置', click: () => sendCommand('open-settings') },
    { label: '退出', click: () => app.quit() }
  ]));
  tray.setToolTip(active ? 'Floating Pet · 陪伴中' : 'Floating Pet · 感知关闭');
}

function stopSnap() {
  if (snapTimer) clearInterval(snapTimer);
  snapTimer = null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function initialWindowPosition() {
  const primary = electronScreen.getPrimaryDisplay().workArea;
  const fallback = {
    x: primary.x + primary.width - WINDOW_SIZE.width - 18,
    y: primary.y + primary.height - WINDOW_SIZE.height - 18
  };
  if (!Number.isInteger(userConfig.window.x) || !Number.isInteger(userConfig.window.y)) return fallback;
  const work = electronScreen.getDisplayNearestPoint({ x: userConfig.window.x, y: userConfig.window.y }).workArea;
  const minX = work.x + 8;
  const minY = work.y + 8;
  return {
    x: clamp(userConfig.window.x, minX, Math.max(minX, work.x + work.width - WINDOW_SIZE.width - 8)),
    y: clamp(userConfig.window.y, minY, Math.max(minY, work.y + work.height - WINDOW_SIZE.height - 8))
  };
}

function rememberWindowPosition() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  lastWindowPosition = { x: bounds.x, y: bounds.y };
}

async function persistWindowPosition() {
  const run = settingsOperation.catch(() => {}).then(async () => {
    rememberWindowPosition();
    if (!configFilePath || !Number.isInteger(lastWindowPosition.x) || !Number.isInteger(lastWindowPosition.y)) return;
    userConfig = normalizeUserConfig({ ...userConfig, window: lastWindowPosition });
    await writeUserConfig(configFilePath, userConfig);
  });
  settingsOperation = run;
  return run;
}

function moveWindow(x, y) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { width, height } = mainWindow.getContentBounds();
  const nextX = Math.round(x);
  const nextY = Math.round(y);
  mainWindow.setContentBounds({ x: nextX, y: nextY, width, height }, false);
  lastWindowPosition = { x: nextX, y: nextY };
}

function snapToEdge(releaseVelocity = { x: 0, y: 0 }) {
  if (!releaseVelocity || typeof releaseVelocity !== 'object') releaseVelocity = {};
  if (!mainWindow || mainWindow.isDestroyed()) return;
  stopSnap();
  const bounds = mainWindow.getBounds();
  const work = electronScreen.getDisplayMatching(bounds).workArea;
  const reducedMotion = releaseVelocity.reducedMotion === true;
  const releaseX = reducedMotion ? 0 : clamp(Number(releaseVelocity.x) || 0, -1800, 1800);
  const releaseY = reducedMotion ? 0 : clamp(Number(releaseVelocity.y) || 0, -1800, 1800);
  const projectedCenterX = bounds.x + bounds.width / 2 + releaseX * 0.14;
  const left = work.x + 8;
  const right = work.x + work.width - bounds.width - 8;
  const targetX = projectedCenterX < work.x + work.width / 2 ? left : right;
  const targetY = clamp(bounds.y + releaseY * 0.06, work.y + 8, work.y + work.height - bounds.height - 8);
  if (reducedMotion) {
    moveWindow(targetX, targetY);
    void persistWindowPosition().catch(() => {});
    return;
  }
  let x = bounds.x;
  let y = bounds.y;
  let vx = releaseX;
  let vy = releaseY;
  const startedAt = performance.now();
  let previousAt = startedAt;
  snapTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return stopSnap();
    const currentAt = performance.now();
    let remaining = Math.min((currentAt - previousAt) / 1000, 0.064);
    previousAt = currentAt;
    while (remaining > 0) {
      const step = Math.min(remaining, 1 / 120);
      vx += ((targetX - x) * 400 - vx * 40) * step;
      vy += ((targetY - y) * 400 - vy * 40) * step;
      x += vx * step;
      y += vy * step;
      remaining -= step;
    }
    moveWindow(x, y);
    if (currentAt - startedAt >= 500 || (Math.abs(targetX - x) < 0.5 && Math.abs(targetY - y) < 0.5 && Math.abs(vx) < 5 && Math.abs(vy) < 5)) {
      moveWindow(targetX, targetY);
      stopSnap();
      void persistWindowPosition().catch(() => {});
    }
  }, 16);
}

function createWindow() {
  const position = initialWindowPosition();
  lastWindowPosition = position;
  mainWindow = new BrowserWindow({
    ...WINDOW_SIZE,
    ...position,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: TEST_MODE,
      additionalArguments: [
        ...(TEST_MODE ? ['--pet-test-mode'] : []),
        ...(FAKE_MODEL ? ['--pet-fake-model'] : [])
      ]
    }
  });
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  // Electron 43 on current Windows builds only applies the topmost style
  // reliably when an explicit native z-order level is supplied.
  mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.loadFile(path.join(ROOT, 'dist', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    let pinAttempts = 0;
    const pinWindow = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      pinAttempts += 1;
      mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
      if (!mainWindow.isAlwaysOnTop() && pinAttempts < 10) setTimeout(pinWindow, 100);
    };
    mainWindow.once('show', () => setTimeout(pinWindow, 100));
    mainWindow.showInactive();
    if (!TEST_MODE) {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
      clickThroughInitialized = true;
    }
  });
  mainWindow.webContents.on('render-process-gone', () => {
    realtimeRequestGeneration += 1;
    void closeRealtime('renderer_gone');
    cancelScreenAnalyses();
    latestSnapshot = { phase: 'IDLE_VISIBLE', activeLevel: 'balanced', dnd: false, activeInputs: [] };
    rebuildTrayMenu();
  });
}

async function configureMedia() {
  const trustedOrigin = (webContents, origin = '') => {
    if (webContents !== mainWindow?.webContents) return false;
    const value = origin || webContents.getURL();
    try { return new URL(value).protocol === 'file:'; } catch { return false; }
  };
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    const allowedMedia = mediaTypes.length === 0 || mediaTypes.every((type) => type === 'audio' || type === 'video');
    callback(Boolean(trustedOrigin(webContents, details.requestingUrl) && allowedMedia && (permission === 'media' || permission === 'display-capture')));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return Boolean(trustedOrigin(webContents, requestingOrigin) && (permission === 'media' || permission === 'display-capture'));
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!trustedOrigin(request.webContents, request.securityOrigin || request.frame?.url)) return callback({});
    if (!selectedSourceId) return callback({});
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    const source = sources.find((item) => item.id === selectedSourceId);
    callback(source ? { video: source } : {});
  });
}

function trustedRenderer(event) {
  if (!mainWindow || event?.sender !== mainWindow.webContents || event?.senderFrame !== mainWindow.webContents.mainFrame) return false;
  try { return new URL(event.senderFrame.url).protocol === 'file:'; } catch { return false; }
}

function realtimeEndpoint(mode) {
  const url = new URL(currentRealtimeConfig().endpoint);
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('invalid_realtime_endpoint');
  url.searchParams.set('mode', mode);
  return url.toString();
}

function closeRealtime(reason = 'shutdown') {
  const client = realtimeClient;
  realtimeClient = null;
  realtimeUnsubscribe?.();
  realtimeUnsubscribe = null;
  if (client) {
    realtimeClosePromise = realtimeClosePromise
      .then(() => client.stop(reason))
      .catch(() => undefined);
  }
  return realtimeClosePromise;
}

function cancelScreenAnalyses() {
  for (const controller of screenAnalysisControllers.values()) controller.abort();
  screenAnalysisControllers.clear();
}

async function updateSettingsNow(patch) {
  if (!isRecord(patch)) return { ok: false, code: 'invalid_settings' };
  const next = {
    ...userConfig,
    preferences: { ...userConfig.preferences },
    profiles: { ...userConfig.profiles }
  };
  let reconnect = false;

  if (patch.preferences != null) {
    if (!isRecord(patch.preferences)) return { ok: false, code: 'invalid_settings' };
    const preferences = patch.preferences;
    if (Object.hasOwn(preferences, 'activeLevel')) {
      if (!['quiet', 'balanced', 'active'].includes(preferences.activeLevel)) return { ok: false, code: 'invalid_settings' };
      next.preferences.activeLevel = preferences.activeLevel;
    }
    for (const name of ['voice', 'captions', 'openAtLogin']) {
      if (!Object.hasOwn(preferences, name)) continue;
      if (typeof preferences[name] !== 'boolean') return { ok: false, code: 'invalid_settings' };
      next.preferences[name] = preferences[name];
    }
  }

  if (Object.hasOwn(patch, 'profile')) {
    const profile = normalizeProfile(patch.profile);
    if (!profile) return { ok: false, code: 'invalid_profile' };
    if (!Object.hasOwn(next.profiles, profile.id) && Object.keys(next.profiles).length >= 32) {
      return { ok: false, code: 'profile_limit' };
    }
    next.profiles[profile.id] = profile;
    reconnect = profile.id === next.activeProfileId;
  }

  if (Object.hasOwn(patch, 'removeProfileId')) {
    const id = patch.removeProfileId;
    if (typeof id !== 'string' || !Object.hasOwn(next.profiles, id)) return { ok: false, code: 'invalid_profile' };
    delete next.profiles[id];
    if (next.activeProfileId === id) {
      next.activeProfileId = '';
      reconnect = true;
    }
  }

  if (Object.hasOwn(patch, 'activeProfileId')) {
    const id = patch.activeProfileId;
    if (id !== '' && (typeof id !== 'string' || !Object.hasOwn(next.profiles, id))) {
      return { ok: false, code: 'invalid_profile' };
    }
    reconnect ||= id !== next.activeProfileId;
    next.activeProfileId = id;
  }

  try {
    const settings = await saveUserConfig(normalizeUserConfig(next), { reconnect });
    return { ok: true, settings };
  } catch {
    return { ok: false, code: 'save_failed' };
  }
}

function updateSettings(patch) {
  const run = settingsOperation.catch(() => {}).then(() => updateSettingsNow(patch));
  settingsOperation = run;
  return run;
}

async function selectCredentialDirectory() {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择模型连接凭据目录',
      properties: ['openDirectory', 'dontAddToRecent']
    });
    if (result.canceled || result.filePaths.length !== 1) return { ok: false, code: 'cancelled' };
    const directory = result.filePaths[0];
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name.toLowerCase()));
    const hasKey = ['id_rsa', 'id_ed25519', 'key'].some((name) => files.has(name));
    const hasFrpc = files.has('frpc.exe');
    const hasFrpcConfig = files.has('frpc_visitor.toml');
    if (!files.has('ssh_config') || !hasKey || hasFrpc !== hasFrpcConfig) {
      return { ok: false, code: 'credentials_missing' };
    }
    return { ok: true, credentialDir: directory };
  } catch {
    return { ok: false, code: 'credentials_missing' };
  }
}

function registerIpc() {
  ipcMain.handle('window:drag-start', (event) => {
    if (!trustedRenderer(event)) return null;
    stopSnap();
    return mainWindow?.getBounds() ?? null;
  });
  ipcMain.on('window:drag-move', (event, point) => {
    if (!trustedRenderer(event)) return;
    if (!mainWindow || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
    moveWindow(point.x, point.y);
  });
  ipcMain.on('window:drag-end', (event, velocity) => {
    if (!trustedRenderer(event)) return;
    snapToEdge(velocity);
  });
  ipcMain.on('window:set-ignore-mouse', (event, ignored) => {
    if (!trustedRenderer(event)) return;
    if (!mainWindow || TEST_MODE) return;
    mainWindow.setIgnoreMouseEvents(Boolean(ignored), { forward: true });
    if (ignored) clickThroughInitialized = true;
  });
  ipcMain.on('window:focus', (event) => {
    if (!trustedRenderer(event)) return;
    mainWindow?.setFocusable(true);
    mainWindow?.focus();
  });
  ipcMain.handle('capture:list-sources', async (event) => {
    if (!trustedRenderer(event)) return [];
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    return sources.slice(0, 24).map(({ id, name }) => ({ id, name: String(name).slice(0, 100) }));
  });
  ipcMain.handle('capture:select-source', async (event, id) => {
    if (!trustedRenderer(event)) return false;
    if (typeof id !== 'string' || id.length > 200) return false;
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    if (!sources.some((item) => item.id === id)) return false;
    selectedSourceId = id;
    return true;
  });
  ipcMain.handle('settings:get', (event) => {
    if (!trustedRenderer(event)) return { ok: false, code: 'invalid_sender' };
    return { ok: true, settings: publicSettings() };
  });
  ipcMain.handle('settings:update', async (event, patch) => {
    if (!trustedRenderer(event)) return { ok: false, code: 'invalid_sender' };
    return updateSettings(patch);
  });
  ipcMain.handle('model:connection-state', (event) => {
    if (!trustedRenderer(event)) return { state: 'idle', code: 'invalid_sender', health: null };
    return connectionState;
  });
  ipcMain.handle('model:connect', async (event) => {
    if (!trustedRenderer(event)) return { state: 'idle', code: 'invalid_sender', health: null };
    await supervisorOperation.catch(() => {});
    if (!modelSupervisor) return connectionState;
    try {
      return await modelSupervisor.retry();
    } catch {
      return { state: 'connection_refused', code: 'connection_refused', health: null };
    }
  });
  ipcMain.handle('model:select-profile', async (event, id) => {
    if (!trustedRenderer(event)) return { ok: false, code: 'invalid_sender' };
    return updateSettings({ activeProfileId: id });
  });
  ipcMain.handle('model:select-credentials', async (event) => {
    if (!trustedRenderer(event)) return { ok: false, code: 'invalid_sender' };
    return selectCredentialDirectory();
  });
  ipcMain.handle('model:chat', async (event, request) => {
    if (!trustedRenderer(event)) {
      return { ok: false, code: 'invalid_sender', message: '模型请求无效。' };
    }
    if (FAKE_MODEL) return fakeChat(request);
    if (request?.localOnly === true) return fallbackChat(request);
    return modelChat(request, currentModelConfig());
  });
  ipcMain.handle('model:capabilities', async (event) => {
    if (!trustedRenderer(event)) {
      return {
        state: 'degraded', mode: null, chatCompletions: false, imageInput: false, chatAudioInput: false,
        realtime: false, audioInput: false, video: false, audioOutput: false, serviceFake: false, reason: 'invalid_sender'
      };
    }
    return FAKE_MODEL ? fakeCapabilities() : modelCapabilities(currentModelConfig());
  });
  ipcMain.handle('model:analyze-screen', async (event, request) => {
    if (!trustedRenderer(event)) return { ok: false, code: 'invalid_sender' };
    if (FAKE_MODEL) return { ok: false, code: 'capability_missing' };
    if (!Number.isSafeInteger(request?.requestId) || request.requestId < 1) return { ok: false, code: 'invalid_input' };
    screenAnalysisControllers.get(request.requestId)?.abort();
    const controller = new AbortController();
    screenAnalysisControllers.set(request.requestId, controller);
    try {
      return await modelAnalyzeScreen(request.imageDataUrl, currentModelConfig(controller.signal));
    } finally {
      if (screenAnalysisControllers.get(request.requestId) === controller) screenAnalysisControllers.delete(request.requestId);
    }
  });
  ipcMain.on('model:cancel-screen-analysis', (event, requestId) => {
    if (!trustedRenderer(event) || !Number.isSafeInteger(requestId) || requestId < 1) return;
    screenAnalysisControllers.get(requestId)?.abort();
    screenAnalysisControllers.delete(requestId);
  });
  ipcMain.handle('realtime:start', async (event, request = {}) => {
    if (!trustedRenderer(event)) return { ok: false, code: 'invalid_sender', message: '实时请求无效。' };
    if (!request || typeof request !== 'object' || !['audio', 'video'].includes(request.mode)
        || !Number.isSafeInteger(request.requestId) || request.requestId < 1) {
      return { ok: false, code: 'invalid_input', message: '实时请求无效。' };
    }
    const generation = ++realtimeRequestGeneration;
    if (TEST_MODE) latestRealtimeAppendMeta = null;
    await closeRealtime('replaced');
    if (generation !== realtimeRequestGeneration) return { ok: false, code: 'cancelled', message: '实时连接已取消。' };
    let client;
    let unsubscribe;
    try {
      const Client = FAKE_MODEL ? FakeRealtimeClient : RealtimeClient;
      const realtimeConfig = currentRealtimeConfig();
      client = new Client({
        url: realtimeEndpoint(request.mode),
        mode: request.mode,
        timeoutMs: realtimeConfig.timeoutMs,
        outputTimeoutMs: realtimeConfig.outputTimeoutMs
      });
      realtimeClient = client;
      unsubscribe = client.onEvent((output) => {
        if (realtimeClient !== client || generation !== realtimeRequestGeneration) return;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('realtime:event', { ...output, requestId: request.requestId });
        }
      });
      realtimeUnsubscribe = unsubscribe;
      const result = await client.start({ mode: request.mode, systemPrompt: request.systemPrompt || '' });
      if (generation !== realtimeRequestGeneration) {
        if (realtimeClient === client) await closeRealtime('cancelled');
        else {
          unsubscribe?.();
          await client.stop('cancelled').catch(() => undefined);
        }
        return { ok: false, code: 'cancelled', message: '实时连接已取消。' };
      }
      return { ok: true, ...result };
    } catch (error) {
      if (realtimeClient === client) await closeRealtime('start_failed');
      else {
        unsubscribe?.();
        if (client) await client.stop('start_failed').catch(() => undefined);
      }
      return { ok: false, code: error?.code || 'realtime_unavailable', message: '实时连接暂不可用。' };
    }
  });
  ipcMain.handle('realtime:append', async (event, input) => {
    if (!trustedRenderer(event) || !realtimeClient) return { ok: false, code: 'not_ready', message: '实时连接未就绪。' };
    if (TEST_MODE) {
      latestRealtimeAppendMeta = {
        hasAudio: typeof input?.audio === 'string' && input.audio.length > 0,
        videoFrameCount: Array.isArray(input?.videoFrames) ? input.videoFrames.length : 0,
        jpegOnly: Array.isArray(input?.videoFrames) && input.videoFrames.every(isJpegFrame)
      };
    }
    try {
      const result = await realtimeClient.append(input);
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, code: error?.code || 'append_failed', message: '实时输入未发送。' };
    }
  });
  ipcMain.handle('realtime:stop', async (event, reason) => {
    if (!trustedRenderer(event)) return { ok: false, code: 'invalid_sender', message: '实时请求无效。' };
    realtimeRequestGeneration += 1;
    await closeRealtime(typeof reason === 'string' ? reason : 'user_stop');
    return { ok: true };
  });
  ipcMain.on('app:update-state', (event, snapshot) => {
    if (!trustedRenderer(event)) return;
    latestSnapshot = boundedSnapshot(snapshot);
    rebuildTrayMenu();
  });
  ipcMain.on('app:quit', (event) => { if (trustedRenderer(event)) app.quit(); });
  ipcMain.on('app:renderer-ready', (event, report) => {
    if (!trustedRenderer(event)) return;
    if (!SMOKE_REPORT || smokeWritten) return;
    const writeReport = () => {
      if (smokeWritten) return;
      smokeWritten = true;
      const safe = {
        shell: {
          transparent: true,
          alwaysOnTop: mainWindow?.isAlwaysOnTop() === true,
          skipTaskbar: true,
          clickThroughInitialized,
          focusedAtReady: mainWindow?.isFocused() === true,
          testMode: TEST_MODE
        },
        mediaCallsBeforeStart: Number(report?.mediaCallsBeforeStart) || 0,
        activeInputs: Array.isArray(report?.activeInputs) ? report.activeInputs : [],
        phase: String(report?.phase || ''),
        exitCode: 0
      };
      fs.mkdirSync(path.dirname(SMOKE_REPORT), { recursive: true });
      fs.writeFileSync(SMOKE_REPORT, JSON.stringify(safe, null, 2), 'utf8');
      setTimeout(() => app.quit(), 100);
    };
    if (mainWindow?.isVisible()) setTimeout(writeReport, 50);
    else mainWindow?.once('ready-to-show', () => setTimeout(writeReport, 50));
  });
  if (TEST_MODE) {
    ipcMain.handle('test:get-shell', (event) => {
      if (!trustedRenderer(event)) return { transparent: false, alwaysOnTop: false, skipTaskbar: false, fakeModel: false };
      return ({
      transparent: true,
      alwaysOnTop: mainWindow?.isAlwaysOnTop() === true,
      skipTaskbar: true,
      fakeModel: FAKE_MODEL
      });
    });
    ipcMain.handle('test:get-bounds', (event) => trustedRenderer(event) ? mainWindow?.getBounds() ?? null : null);
    ipcMain.handle('test:get-realtime-append', (event) => trustedRenderer(event) ? latestRealtimeAppendMeta : null);
    ipcMain.handle('test:set-size', (event, width, height) => {
      if (!trustedRenderer(event)) return false;
      if (!mainWindow || !Number.isInteger(width) || !Number.isInteger(height)) return false;
      mainWindow.setSize(clamp(width, 360, 900), clamp(height, 520, 900), false);
      return true;
    });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) mainWindow.showInactive();
  });
  app.whenReady().then(async () => {
    configFilePath = path.join(app.getPath('userData'), 'config.json');
    try {
      userConfig = await readUserConfig(configFilePath);
    } catch {
      userConfig = normalizeUserConfig(null);
    }
    activeProfile = userConfig.profiles[userConfig.activeProfileId] || null;
    applyLoginSetting();
    await configureMedia();
    registerIpc();
    createWindow();
    const trayImage = nativeImage.createFromPath(path.join(ROOT, 'build', 'tray.png')).resize({ width: 20, height: 20 });
    tray = new Tray(trayImage);
    tray.on('click', () => mainWindow?.showInactive());
    rebuildTrayMenu();
    await reconfigureSupervisor(activeProfile);
  });
  app.on('before-quit', (event) => {
    if (shutdownReady) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    stopSnap();
    realtimeRequestGeneration += 1;
    cancelScreenAnalyses();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('capture:shutdown');
    let timeoutId;
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(resolve, 4_000);
    });
    void Promise.race([
      Promise.allSettled([persistWindowPosition(), closeRealtime('shutdown'), stopSupervisor()]),
      timeout
    ]).finally(() => {
      clearTimeout(timeoutId);
      shutdownReady = true;
      app.quit();
    });
  });
  app.on('window-all-closed', () => app.quit());
}
