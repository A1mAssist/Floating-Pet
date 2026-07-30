(() => {
  'use strict';

  const MAX_PROXY_PAYLOAD_CHARS = 6 * 1024 * 1024;
  const MAX_PROXY_RESULT_CHARS = 8 * 1024 * 1024;
  const listeners = Object.freeze({
    command: new Set(),
    realtime: new Set(),
    shutdown: new Set()
  });

  class NativeBridgeError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'NativeBridgeError';
      this.code = code;
    }
  }

  function subscribe(channel, handler) {
    if (typeof handler !== 'function') return () => undefined;
    listeners[channel].add(handler);
    return () => listeners[channel].delete(handler);
  }

  async function invoke(method, payload = {}) {
    const proxy = globalThis.FloatPetNative;
    if (!proxy || typeof proxy.invoke !== 'function') {
      throw new NativeBridgeError('bridge_unavailable', '系统能力桥接未就绪。');
    }
    const payloadJson = JSON.stringify(payload ?? {});
    if (typeof payloadJson !== 'string' || payloadJson.length > MAX_PROXY_PAYLOAD_CHARS) {
      throw new NativeBridgeError('invalid_input', '请求数据无效。');
    }

    let raw;
    try {
      raw = await proxy.invoke(method, payloadJson);
    } catch {
      throw new NativeBridgeError('bridge_error', '系统能力调用失败。');
    }
    if (typeof raw !== 'string' || raw.length > MAX_PROXY_RESULT_CHARS) {
      throw new NativeBridgeError('invalid_response', '系统能力返回无效。');
    }

    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new NativeBridgeError('invalid_response', '系统能力返回无效。');
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw new NativeBridgeError('invalid_response', '系统能力返回无效。');
    }
    if (envelope.ok === true && Object.hasOwn(envelope, 'value')) return envelope.value;
    const code = typeof envelope.error?.code === 'string' && /^[a-z0-9_-]{1,64}$/i.test(envelope.error.code)
      ? envelope.error.code
      : 'native_error';
    const message = typeof envelope.error?.message === 'string' && envelope.error.message.length <= 512
      ? envelope.error.message
      : '系统能力暂不可用。';
    throw new NativeBridgeError(code, message);
  }

  function fire(method, payload = {}) {
    void invoke(method, payload).catch((error) => {
      console.error(`[FloatPet] NATIVE_CALL_FAILED method=${method} code=${String(error?.code || 'native_error')}`);
    });
  }

  function receiveNativeEvent(channel, value) {
    if (!Object.hasOwn(listeners, channel)) return false;
    for (const handler of [...listeners[channel]]) {
      try { handler(value); } catch { /* subscriber failures are isolated */ }
    }
    return true;
  }

  Object.defineProperty(globalThis, '__floatPetNativeEvent', {
    value: receiveNativeEvent,
    configurable: false,
    enumerable: false,
    writable: false
  });

  const api = {
    runtime: Object.freeze({ fakeModel: false, modelLabel: 'Ascend MiniCPM-o', testMode: false }),
    window: Object.freeze({
      beginDrag: () => invoke('window.beginDrag'),
      moveDrag: (x, y) => fire('window.moveDrag', { x, y }),
      endDrag: (x, y, reducedMotion) => fire('window.endDrag', { x, y, reducedMotion: Boolean(reducedMotion) }),
      setClickThrough(ignored) {
        void invoke('window.setClickThrough', { ignored: Boolean(ignored) }).catch((error) => {
          if (error?.code !== 'unsupported') {
            console.error(`[FloatPet] NATIVE_CALL_FAILED method=window.setClickThrough code=${String(error?.code || 'native_error')}`);
          }
        });
      },
      focus: () => fire('window.focus')
    }),
    capture: Object.freeze({
      nativeFrames: true,
      listSources: () => invoke('capture.listSources'),
      selectSource: (id) => invoke('capture.selectSource', { id }),
      frame: () => invoke('capture.frame'),
      onShutdown: (handler) => subscribe('shutdown', handler)
    }),
    model: Object.freeze({
      capabilities: () => invoke('model.capabilities'),
      analyzeScreen: (request) => invoke('model.analyzeScreen', request),
      cancelScreenAnalysis: (requestId) => fire('model.cancelScreenAnalysis', { requestId }),
      chat: (request) => invoke('model.chat', request)
    }),
    realtime: Object.freeze({
      start: (request) => invoke('realtime.start', request),
      append: (input) => invoke('realtime.append', input),
      stop: (reason) => invoke('realtime.stop', { reason }),
      onEvent: (handler) => subscribe('realtime', handler)
    }),
    app: Object.freeze({
      onCommand: (handler) => subscribe('command', handler),
      updateState: (snapshot) => fire('app.updateState', snapshot),
      rendererReady: (report) => fire('app.rendererReady', report),
      quit: () => fire('app.quit')
    })
  };

  Object.defineProperty(globalThis, 'pet', {
    value: Object.freeze(api),
    configurable: false,
    enumerable: true,
    writable: false
  });

  console.info('[FloatPet] HARMONY_BRIDGE_READY');
})();
