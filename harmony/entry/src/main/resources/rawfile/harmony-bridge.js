(() => {
  'use strict';

  const listeners = { command: new Set(), realtime: new Set(), shutdown: new Set() };
  const subscribe = (set, handler) => {
    if (typeof handler === 'function') set.add(handler);
    return () => set.delete(handler);
  };
  const unavailableCapabilities = Object.freeze({
    state: 'degraded',
    mode: null,
    chatCompletions: false,
    imageInput: false,
    chatAudioInput: false,
    realtime: false,
    audioInput: false,
    video: false,
    audioOutput: false,
    serviceFake: false,
    reason: 'harmony_native_bridge_pending'
  });

  function localFallback(request) {
    const messages = Array.isArray(request?.messages) ? request.messages : [];
    const content = String(messages.at(-1)?.content || '').slice(0, 4000);
    const turn = Number.isSafeInteger(request?.turn) ? request.turn : 0;
    const result = window.FloatingPetCore?.fakeReply(content, turn)
      || { ok: false, code: 'capability_missing', message: '本机回应暂不可用。' };
    return {
      ...result,
      source: 'fake',
      degraded: true,
      reason: 'capability_missing',
      remoteAttempted: false,
      visualUsed: false,
      audioUsed: false
    };
  }

  window.pet = Object.freeze({
    runtime: Object.freeze({ fakeModel: false, modelLabel: 'HarmonyOS MiniCPM-o', testMode: false }),
    window: Object.freeze({
      beginDrag: async () => null,
      moveDrag() {},
      endDrag() {},
      setClickThrough() {},
      focus() {}
    }),
    capture: Object.freeze({
      listSources: async () => [],
      selectSource: async () => false,
      onShutdown: (handler) => subscribe(listeners.shutdown, handler)
    }),
    model: Object.freeze({
      capabilities: async () => ({ ...unavailableCapabilities }),
      analyzeScreen: async () => ({ ok: false, code: 'capability_missing' }),
      cancelScreenAnalysis() {},
      chat: async (request) => localFallback(request)
    }),
    realtime: Object.freeze({
      start: async () => ({ ok: false, code: 'capability_missing', message: '实时桥接暂不可用。' }),
      append: async () => ({ ok: false, code: 'capability_missing' }),
      stop: async () => ({ ok: true }),
      onEvent: (handler) => subscribe(listeners.realtime, handler)
    }),
    app: Object.freeze({
      onCommand: (handler) => subscribe(listeners.command, handler),
      updateState() {},
      rendererReady(report) {
        console.info(`[FloatPet] RENDERER_READY phase=${String(report?.phase || '')}`);
      },
      quit() {
        console.info('[FloatPet] QUIT_REQUESTED');
      }
    })
  });

  console.info('[FloatPet] HARMONY_BRIDGE_READY');
})();
