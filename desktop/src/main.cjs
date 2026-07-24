'use strict';

const { app, BrowserWindow, Menu, Tray, ipcMain, screen: electronScreen, session, desktopCapturer, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
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
const MODEL_CONFIG = Object.freeze({
  endpoint: process.env.FLOATING_PET_MODEL_URL || 'http://127.0.0.1:18000',
  model: process.env.FLOATING_PET_MODEL_NAME || 'cpmo',
  token: process.env.FLOATING_PET_MODEL_TOKEN || '',
  timeoutMs: Number.isInteger(parsedModelTimeout) && parsedModelTimeout >= 1000 && parsedModelTimeout <= 300000 ? parsedModelTimeout : 120000
});
const parsedRealtimeTimeout = Number.parseInt(process.env.FLOATING_PET_REALTIME_TIMEOUT_MS || '', 10);
const parsedRealtimeOutputTimeout = Number.parseInt(process.env.FLOATING_PET_REALTIME_OUTPUT_TIMEOUT_MS || '', 10);
const REALTIME_CONFIG = Object.freeze({
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

function moveWindow(x, y) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { width, height } = mainWindow.getContentBounds();
  mainWindow.setContentBounds({ x: Math.round(x), y: Math.round(y), width, height }, false);
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
    }
  }, 16);
}

function createWindow() {
  const work = electronScreen.getPrimaryDisplay().workArea;
  mainWindow = new BrowserWindow({
    ...WINDOW_SIZE,
    x: work.x + work.width - WINDOW_SIZE.width - 18,
    y: work.y + work.height - WINDOW_SIZE.height - 18,
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
  const url = new URL(REALTIME_CONFIG.endpoint);
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
  ipcMain.handle('model:chat', async (event, request) => {
    if (!trustedRenderer(event)) {
      return { ok: false, code: 'invalid_sender', message: '模型请求无效。' };
    }
    if (FAKE_MODEL) return fakeChat(request);
    if (request?.localOnly === true) return fallbackChat(request);
    return modelChat(request, MODEL_CONFIG);
  });
  ipcMain.handle('model:capabilities', async (event) => {
    if (!trustedRenderer(event)) {
      return {
        state: 'degraded', mode: null, chatCompletions: false, imageInput: false, chatAudioInput: false,
        realtime: false, audioInput: false, video: false, audioOutput: false, serviceFake: false, reason: 'invalid_sender'
      };
    }
    return FAKE_MODEL ? fakeCapabilities() : modelCapabilities(MODEL_CONFIG);
  });
  ipcMain.handle('model:analyze-screen', async (event, request) => {
    if (!trustedRenderer(event)) return { ok: false, code: 'invalid_sender' };
    if (FAKE_MODEL) return { ok: false, code: 'capability_missing' };
    if (!Number.isSafeInteger(request?.requestId) || request.requestId < 1) return { ok: false, code: 'invalid_input' };
    screenAnalysisControllers.get(request.requestId)?.abort();
    const controller = new AbortController();
    screenAnalysisControllers.set(request.requestId, controller);
    try {
      return await modelAnalyzeScreen(request.imageDataUrl, { ...MODEL_CONFIG, signal: controller.signal });
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
      client = new Client({
        url: realtimeEndpoint(request.mode),
        mode: request.mode,
        timeoutMs: REALTIME_CONFIG.timeoutMs,
        outputTimeoutMs: REALTIME_CONFIG.outputTimeoutMs
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
    await configureMedia();
    registerIpc();
    createWindow();
    const trayImage = nativeImage.createFromPath(path.join(ROOT, 'build', 'tray.png')).resize({ width: 20, height: 20 });
    tray = new Tray(trayImage);
    tray.on('click', () => mainWindow?.showInactive());
    rebuildTrayMenu();
  });
  app.on('before-quit', () => {
    stopSnap();
    void closeRealtime('shutdown');
    cancelScreenAnalyses();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('capture:shutdown');
  });
  app.on('window-all-closed', () => app.quit());
}
