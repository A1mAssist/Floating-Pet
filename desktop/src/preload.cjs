'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const TEST_MODE = process.argv.includes('--pet-test-mode');
const FAKE_MODEL = process.argv.includes('--pet-fake-model') || TEST_MODE;

const api = {
  runtime: Object.freeze({
    fakeModel: FAKE_MODEL,
    modelLabel: FAKE_MODEL ? 'Fake Adapter' : 'Ascend MiniCPM-o',
    testMode: TEST_MODE
  }),
  window: Object.freeze({
    beginDrag: () => ipcRenderer.invoke('window:drag-start'),
    moveDrag: (x, y) => ipcRenderer.send('window:drag-move', { x, y }),
    endDrag: (x, y, reducedMotion) => ipcRenderer.send('window:drag-end', { x, y, reducedMotion: Boolean(reducedMotion) }),
    setClickThrough: (ignored) => ipcRenderer.send('window:set-ignore-mouse', Boolean(ignored)),
    focus: () => ipcRenderer.send('window:focus')
  }),
  capture: Object.freeze({
    listSources: () => ipcRenderer.invoke('capture:list-sources'),
    selectSource: (id) => ipcRenderer.invoke('capture:select-source', id),
    onShutdown: (handler) => {
      const wrapped = () => Promise.resolve(handler()).catch(() => undefined);
      ipcRenderer.on('capture:shutdown', wrapped);
      return () => ipcRenderer.removeListener('capture:shutdown', wrapped);
    }
  }),
  settings: Object.freeze({
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch)
  }),
  model: Object.freeze({
    chat: (request) => ipcRenderer.invoke('model:chat', request),
    capabilities: () => ipcRenderer.invoke('model:capabilities'),
    analyzeScreen: (request) => ipcRenderer.invoke('model:analyze-screen', request),
    cancelScreenAnalysis: (requestId) => ipcRenderer.send('model:cancel-screen-analysis', requestId),
    connectionState: () => ipcRenderer.invoke('model:connection-state'),
    connect: () => ipcRenderer.invoke('model:connect'),
    selectProfile: (id) => ipcRenderer.invoke('model:select-profile', id),
    selectCredentials: () => ipcRenderer.invoke('model:select-credentials'),
    onConnectionState: (handler) => {
      const wrapped = (_event, state) => handler(state);
      ipcRenderer.on('model:connection-state-changed', wrapped);
      return () => ipcRenderer.removeListener('model:connection-state-changed', wrapped);
    }
  }),
  realtime: Object.freeze({
    start: (request) => ipcRenderer.invoke('realtime:start', request),
    append: (input) => ipcRenderer.invoke('realtime:append', input),
    stop: (reason) => ipcRenderer.invoke('realtime:stop', reason),
    onEvent: (handler) => {
      const wrapped = (_event, output) => handler(output);
      ipcRenderer.on('realtime:event', wrapped);
      return () => ipcRenderer.removeListener('realtime:event', wrapped);
    }
  }),
  app: Object.freeze({
    onCommand: (handler) => {
      const wrapped = (_event, command) => handler(command);
      ipcRenderer.on('app:command', wrapped);
      return () => ipcRenderer.removeListener('app:command', wrapped);
    },
    updateState: (snapshot) => ipcRenderer.send('app:update-state', snapshot),
    rendererReady: (report) => ipcRenderer.send('app:renderer-ready', report),
    quit: () => ipcRenderer.send('app:quit')
  })
};

if (TEST_MODE) {
  api.test = Object.freeze({
    getShell: () => ipcRenderer.invoke('test:get-shell'),
    getBounds: () => ipcRenderer.invoke('test:get-bounds'),
    getRealtimeAppend: () => ipcRenderer.invoke('test:get-realtime-append'),
    setSize: (width, height) => ipcRenderer.invoke('test:set-size', width, height)
  });
}

contextBridge.exposeInMainWorld('pet', Object.freeze(api));
