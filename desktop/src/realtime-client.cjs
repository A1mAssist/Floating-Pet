'use strict';

const DEFAULT_REALTIME_TIMEOUT_MS = 35_000;
const DEFAULT_REALTIME_CLOSE_TIMEOUT_MS = 10_000;
const DEFAULT_REALTIME_OUTPUT_TIMEOUT_MS = 130_000;
const DEFAULT_MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_REALTIME_FRAME_BYTES = 1 * 1024 * 1024;
const MAX_TEXT_CHARS = 4_000;
const MAX_REASON_CHARS = 128;
const MAX_SESSION_ID_CHARS = 256;
const MAX_VIDEO_FRAMES = 2;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 300_000;

class RealtimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RealtimeError';
    this.code = code;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, max, { trim = false, allowEmpty = false, multiline = false } = {}) {
  const invalidControl = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (typeof value !== 'string' || value.length > max || invalidControl.test(value)) return null;
  const result = trim ? value.trim() : value;
  return allowEmpty || result.length ? result : null;
}

function validateMode(value) {
  const mode = boundedString(value, 32, { trim: true });
  return mode && /^[a-z][a-z0-9_-]*$/i.test(mode) ? mode : null;
}

function decodeBase64(value, maxBytes, label, { float32 = false, jpeg = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new RealtimeError('invalid_input', `${label} is invalid.`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new RealtimeError('invalid_input', `${label} is invalid.`);
  }
  const bytes = Buffer.from(value, 'base64');
  const canonical = bytes.toString('base64');
  if (!bytes.length || bytes.length > maxBytes || canonical !== value) {
    throw new RealtimeError('invalid_input', `${label} is invalid.`);
  }
  if (jpeg && !(bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
    throw new RealtimeError('invalid_input', `${label} is invalid.`);
  }
  if (float32) {
    if (bytes.length % 4 !== 0) throw new RealtimeError('invalid_input', `${label} is invalid.`);
    for (let offset = 0; offset < bytes.length; offset += 4) {
      const sample = bytes.readFloatLE(offset);
      if (!Number.isFinite(sample) || Math.abs(sample) > 1) throw new RealtimeError('invalid_input', `${label} is invalid.`);
    }
  }
  return bytes;
}

function validateAudio(value, maxBytes, label = 'audio') {
  decodeBase64(value, maxBytes, label, { float32: true });
  return value;
}

function validateVideoFrames(value, maxBytes) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_VIDEO_FRAMES) {
    throw new RealtimeError('invalid_input', 'videoFrames is invalid.');
  }
  return value.map((frame, index) => {
    const encoded = typeof frame === 'string' && frame.startsWith('data:image/jpeg;base64,')
      ? frame.slice('data:image/jpeg;base64,'.length)
      : frame;
    decodeBase64(encoded, maxBytes, `videoFrames[${index}]`, { jpeg: true });
    return encoded;
  });
}

function validateInput(input, maxChunkBytes) {
  if (!isObject(input)) throw new RealtimeError('invalid_input', 'Realtime input is invalid.');
  const audio = validateAudio(input.audio, maxChunkBytes);
  const videoFrames = validateVideoFrames(
    input.videoFrames ?? input.video_frames,
    Math.min(maxChunkBytes, MAX_REALTIME_FRAME_BYTES)
  );
  const forceListen = input.forceListen ?? input.force_listen;
  const maxSliceNums = input.maxSliceNums ?? input.max_slice_nums ?? 1;
  if (forceListen != null && typeof forceListen !== 'boolean') throw new RealtimeError('invalid_input', 'forceListen is invalid.');
  if (!Number.isInteger(maxSliceNums) || maxSliceNums < 1 || maxSliceNums > 4) {
    throw new RealtimeError('invalid_input', 'maxSliceNums is invalid.');
  }
  const normalized = { audio, video_frames: videoFrames, max_slice_nums: maxSliceNums };
  return normalized;
}

function validateInit(init, fallbackMode) {
  if (init == null) init = {};
  if (!isObject(init)) throw new RealtimeError('invalid_input', 'Realtime init is invalid.');
  const allowed = new Set(['mode', 'systemPrompt', 'system_prompt']);
  for (const key of Object.keys(init)) {
    if (!allowed.has(key)) throw new RealtimeError('invalid_input', 'Realtime init is invalid.');
  }
  const mode = validateMode(init.mode ?? fallbackMode);
  if (!mode) throw new RealtimeError('invalid_input', 'Realtime mode is invalid.');
  const systemPrompt = init.systemPrompt ?? init.system_prompt ?? '';
  if (boundedString(systemPrompt, MAX_TEXT_CHARS, { allowEmpty: true, multiline: true }) == null) {
    throw new RealtimeError('invalid_input', 'systemPrompt is invalid.');
  }
  return { mode, system_prompt: systemPrompt };
}

function normalizeReason(value, fallback) {
  if (value == null) return fallback;
  const reason = boundedString(value, MAX_REASON_CHARS, { trim: true });
  return reason || fallback;
}

function eventData(event) {
  if (event && typeof event === 'object' && 'data' in event) return event.data;
  return event;
}

function decodeMessageData(value, maxBytes) {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new RealtimeError('event_too_large', 'Realtime event is too large.');
    return value;
  }
  if (Buffer.isBuffer(value)) {
    if (value.length > maxBytes) throw new RealtimeError('event_too_large', 'Realtime event is too large.');
    return value.toString('utf8');
  }
  if (value instanceof ArrayBuffer) {
    const bytes = Buffer.from(value);
    if (bytes.length > maxBytes) throw new RealtimeError('event_too_large', 'Realtime event is too large.');
    return bytes.toString('utf8');
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (bytes.length > maxBytes) throw new RealtimeError('event_too_large', 'Realtime event is too large.');
    return bytes.toString('utf8');
  }
  throw new RealtimeError('malformed_event', 'Realtime event is invalid.');
}

function validateServerEvent(raw, maxChunkBytes) {
  if (!isObject(raw) || typeof raw.type !== 'string' || raw.type.length > 64) {
    throw new RealtimeError('malformed_event', 'Realtime event is invalid.');
  }
  switch (raw.type) {
    case 'session.queue_done':
      return { type: raw.type };
    case 'session.created': {
      const sessionId = boundedString(raw.session_id ?? raw.sessionId, MAX_SESSION_ID_CHARS, { trim: true });
      if (!sessionId) throw new RealtimeError('malformed_event', 'Realtime session is invalid.');
      return { type: raw.type, session_id: sessionId };
    }
    case 'response.output.delta': {
      const kind = boundedString(raw.kind, 16, { trim: true });
      const responseId = boundedString(raw.response_id ?? raw.responseId, MAX_SESSION_ID_CHARS, { trim: true });
      if (!kind || !['listen', 'text', 'audio'].includes(kind)) {
        throw new RealtimeError('malformed_event', 'Realtime output is invalid.');
      }
      if (!responseId) throw new RealtimeError('malformed_event', 'Realtime output is invalid.');
      if (raw.is_listen != null && typeof raw.is_listen !== 'boolean') {
        throw new RealtimeError('malformed_event', 'Realtime output is invalid.');
      }
      if (raw.end_of_turn != null && typeof raw.end_of_turn !== 'boolean') {
        throw new RealtimeError('malformed_event', 'Realtime output is invalid.');
      }
      if (raw.current_time != null && (!Number.isFinite(raw.current_time) || raw.current_time < 0)) {
        throw new RealtimeError('malformed_event', 'Realtime output is invalid.');
      }
      if (kind === 'listen') {
        if (raw.text != null || raw.audio != null) throw new RealtimeError('malformed_event', 'Realtime output is invalid.');
        return { type: raw.type, kind, response_id: responseId || '' };
      }
      if (kind === 'text') {
        if (raw.audio != null) throw new RealtimeError('malformed_event', 'Realtime output is invalid.');
        const text = boundedString(raw.text, MAX_TEXT_CHARS, { allowEmpty: false, multiline: true });
        if (!text) throw new RealtimeError('malformed_event', 'Realtime text is invalid.');
        return { type: raw.type, kind, response_id: responseId, text };
      }
      if (raw.text != null) throw new RealtimeError('malformed_event', 'Realtime output is invalid.');
      const audio = validateAudio(raw.audio, maxChunkBytes, 'audio');
      if (raw.sample_rate != null && raw.sample_rate !== 24_000) {
        throw new RealtimeError('malformed_event', 'Realtime audio sample rate is invalid.');
      }
      if (raw.sampleRate != null && raw.sampleRate !== 24_000) {
        throw new RealtimeError('malformed_event', 'Realtime audio sample rate is invalid.');
      }
      return { type: raw.type, kind, response_id: responseId, audio };
    }
    case 'response.done': {
      const responseId = boundedString(raw.response_id ?? raw.responseId, MAX_SESSION_ID_CHARS, { trim: true });
      if (!responseId) throw new RealtimeError('malformed_event', 'Realtime response is invalid.');
      return { type: raw.type, response_id: responseId };
    }
    case 'session.closed':
      return { type: raw.type, reason: normalizeReason(raw.reason, 'server_close') };
    case 'error': {
      const source = isObject(raw.error) ? raw.error : raw;
      const code = boundedString(source.code, 64, { trim: true }) || 'server_error';
      const message = boundedString(source.message, 512, { trim: true }) || 'Realtime service error.';
      return { type: raw.type, code, message };
    }
    default:
      throw new RealtimeError('unknown_event', 'Unknown realtime event.');
  }
}

function normalizedEvent(event) {
  switch (event.type) {
    case 'session.created':
      return { type: 'ready', sessionId: event.session_id };
    case 'response.output.delta':
      if (event.kind === 'listen') return { type: 'listen' };
      if (event.kind === 'text') return { type: 'text', text: event.text, responseId: event.response_id };
      return { type: 'audio', audio: event.audio, sampleRate: 24_000, responseId: event.response_id };
    default:
      return null;
  }
}

class RealtimeClient {
  constructor(options = {}) {
    const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
    if (typeof WebSocketImpl !== 'function') throw new TypeError('WebSocketImpl is required.');
    if (typeof options.url !== 'string' || !options.url || options.url.length > 2048) throw new TypeError('url is invalid.');
    let url;
    try {
      url = new URL(options.url);
    } catch {
      throw new TypeError('url is invalid.');
    }
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new TypeError('url is invalid.');
    const mode = validateMode(options.mode ?? 'duplex');
    if (!mode) throw new TypeError('mode is invalid.');
    const timeoutMs = options.timeoutMs ?? DEFAULT_REALTIME_TIMEOUT_MS;
    const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_REALTIME_CLOSE_TIMEOUT_MS;
    const outputTimeoutMs = options.outputTimeoutMs ?? DEFAULT_REALTIME_OUTPUT_TIMEOUT_MS;
    const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
    if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) throw new TypeError('timeoutMs is invalid.');
    if (!Number.isInteger(closeTimeoutMs) || closeTimeoutMs < MIN_TIMEOUT_MS || closeTimeoutMs > 10_000) throw new TypeError('closeTimeoutMs is invalid.');
    if (!Number.isInteger(outputTimeoutMs) || outputTimeoutMs < MIN_TIMEOUT_MS || outputTimeoutMs > MAX_TIMEOUT_MS) throw new TypeError('outputTimeoutMs is invalid.');
    if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < 4 || maxChunkBytes > 16 * 1024 * 1024) throw new TypeError('maxChunkBytes is invalid.');

    this.WebSocketImpl = WebSocketImpl;
    this.url = url.toString();
    this.mode = mode;
    this.timeoutMs = timeoutMs;
    this.closeTimeoutMs = closeTimeoutMs;
    this.outputTimeoutMs = outputTimeoutMs;
    this.maxChunkBytes = maxChunkBytes;
    this.maxEventBytes = Math.max(16 * 1024, Math.min(32 * 1024 * 1024, maxChunkBytes * 2 + 16 * 1024));
    this._state = 'idle';
    this._phase = 'idle';
    this._socket = null;
    this._socketOpen = false;
    this._handlers = new Set();
    this._timer = null;
    this._outputTimer = null;
    this._outputWaiter = null;
    this._startPromise = null;
    this._startResolve = null;
    this._startReject = null;
    this._closePromise = null;
    this._closeResolve = null;
    this._closeReason = null;
    this._appendChain = Promise.resolve();
    this._sessionId = null;
  }

  get state() {
    return this._state;
  }

  onEvent(handler) {
    if (typeof handler !== 'function') throw new TypeError('handler is required.');
    this._handlers.add(handler);
    return () => this._handlers.delete(handler);
  }

  start(init = {}) {
    if (this._state === 'ready') return Promise.resolve({ type: 'ready', sessionId: this._sessionId });
    if (this._state === 'connecting') return this._startPromise;
    if (this._state === 'closing' || this._state === 'closed') return Promise.reject(new RealtimeError('closed', 'Realtime session is closed.'));
    let payload;
    try {
      payload = validateInit(init, this.mode);
    } catch (error) {
      return Promise.reject(error);
    }
    this._state = 'connecting';
    this._phase = 'queue';
    this._initPayload = payload;
    this._startPromise = new Promise((resolve, reject) => {
      this._startResolve = resolve;
      this._startReject = reject;
    });
    try {
      this._socket = new this.WebSocketImpl(this.url);
      this._bindSocket(this._socket);
      this._armTimer(() => this._protocolFault('timeout', 'Realtime handshake timed out.'));
    } catch {
      this._protocolFault('socket_error', 'Realtime connection failed.');
    }
    return this._startPromise;
  }

  append(input) {
    let payload;
    try {
      payload = validateInput(input, this.maxChunkBytes);
      if (JSON.stringify(payload).length > this.maxEventBytes) throw new RealtimeError('input_too_large', 'Realtime input is too large.');
    } catch (error) {
      return Promise.reject(error);
    }
    const task = this._appendChain.then(async () => {
      if (this._state !== 'ready') throw new RealtimeError('not_ready', 'Realtime session is not ready.');
      const output = this._waitForOutput();
      try {
        await this._send({ type: 'input.append', input: payload });
      } catch (error) {
        this._cancelOutputWaiter();
        this._protocolFault(error.code || 'send_failed', error.code ? error.message : 'Realtime input failed.');
        throw error;
      }
      return output;
    });
    this._appendChain = task.catch(() => undefined);
    return task;
  }

  stop(reason = 'user_stop') {
    const normalizedReason = normalizeReason(reason, 'user_stop');
    if (this._state === 'idle' || this._state === 'closed') return Promise.resolve({ type: 'closed', reason: normalizedReason });
    if (this._closePromise) return this._closePromise;
    this._state = 'closing';
    this._phase = 'closing';
    this._closeReason = normalizedReason;
    this._rejectOutputWaiter(new RealtimeError('stopped', 'Realtime input stopped.'));
    this._closePromise = new Promise((resolve) => { this._closeResolve = resolve; });
    if (this._startReject) {
      this._startReject(new RealtimeError('stopped', 'Realtime session stopped.'));
      this._startReject = null;
      this._startResolve = null;
    }
    if (this._socketOpen && this._socket) {
      this._armTimer(() => {
        if (this._state !== 'closing') return;
        this._emit({ type: 'error', code: 'close_timeout', message: 'Realtime close timed out.' });
        this._forceClosed(normalizedReason);
      }, this.closeTimeoutMs);
      this._send({ type: 'session.close', reason: normalizedReason }).catch(() => this._forceClosed(normalizedReason));
    } else {
      this._forceClosed(normalizedReason);
    }
    return this._closePromise;
  }

  _bindSocket(socket) {
    const bind = (name, handler) => {
      if (typeof socket.addEventListener === 'function') socket.addEventListener(name, handler);
      else if (typeof socket.on === 'function') socket.on(name, handler);
      else socket[`on${name}`] = handler;
    };
    bind('open', () => { this._socketOpen = true; });
    bind('message', (event) => this._handleMessage(event));
    bind('error', () => {
      if (this._state !== 'closed' && this._state !== 'closing') this._protocolFault('socket_error', 'Realtime connection failed.');
    });
    bind('close', () => {
      this._socketOpen = false;
      if (this._state === 'closed') return;
      if (this._state === 'closing') return this._forceClosed(this._closeReason || 'connection_closed');
      const reason = this._state === 'connecting' ? 'connection_closed' : 'connection_lost';
      if (this._state === 'ready') this._emit({ type: 'error', code: 'connection_closed', message: 'Realtime connection closed.' });
      if (this._startReject) {
        this._startReject(new RealtimeError('connection_closed', 'Realtime connection closed.'));
        this._startReject = null;
        this._startResolve = null;
      }
      this._forceClosed(reason);
    });
  }

  _handleMessage(event) {
    if (this._state === 'closed') return;
    let raw;
    try {
      const text = decodeMessageData(eventData(event), this.maxEventBytes);
      raw = JSON.parse(text);
      const validated = validateServerEvent(raw, this.maxChunkBytes);
      this._handleValidatedEvent(validated);
    } catch (error) {
      if (this._state === 'closing') return;
      const code = error instanceof RealtimeError ? error.code : 'malformed_event';
      const message = error instanceof RealtimeError ? error.message : 'Realtime event is invalid.';
      this._protocolFault(code, message);
    }
  }

  _handleValidatedEvent(event) {
    if (this._state === 'closing' && event.type !== 'session.closed') return;
    if (event.type === 'session.queue_done') {
      if (this._state !== 'connecting' || this._phase !== 'queue') throw new RealtimeError('protocol_order', 'Unexpected queue event.');
      this._phase = 'created';
      this._armTimer(() => this._protocolFault('timeout', 'Realtime handshake timed out.'));
      this._send({ type: 'session.init', payload: this._initPayload }).catch(() => this._protocolFault('send_failed', 'Realtime init failed.'));
      return;
    }
    if (event.type === 'session.created') {
      if (this._state !== 'connecting' || this._phase !== 'created') throw new RealtimeError('protocol_order', 'Unexpected session event.');
      this._phase = 'ready';
      this._state = 'ready';
      this._sessionId = event.session_id;
      this._clearTimer();
      const ready = normalizedEvent(event);
      this._emit(ready);
      if (this._startResolve) this._startResolve(ready);
      this._startResolve = null;
      this._startReject = null;
      return;
    }
    if (event.type === 'response.output.delta') {
      if (this._state !== 'ready') throw new RealtimeError('protocol_order', 'Unexpected output event.');
      this._acceptOutputDelta(event.response_id);
      this._emit(normalizedEvent(event));
      return;
    }
    if (event.type === 'response.done') {
      if (this._state !== 'ready') throw new RealtimeError('protocol_order', 'Unexpected response event.');
      if (!this._outputWaiter?.responseId || this._outputWaiter.responseId !== event.response_id) {
        throw new RealtimeError('protocol_order', 'Unexpected response event.');
      }
      this._resolveOutputWaiter(event.response_id);
      return;
    }
    if (event.type === 'session.closed') {
      if (this._state !== 'closing' && this._state !== 'ready' && this._state !== 'connecting') {
        throw new RealtimeError('protocol_order', 'Unexpected close event.');
      }
      const reason = this._state === 'closing' && this._closeReason ? this._closeReason : event.reason;
      this._closeReason = reason;
      this._forceClosed(reason);
      return;
    }
    if (event.type === 'error') {
      this._protocolFault(event.code, event.message);
    }
  }

  async _send(value) {
    if (!this._socket || !this._socketOpen) throw new RealtimeError('not_connected', 'Realtime socket is not open.');
    const serialized = JSON.stringify(value);
    const byteLength = Buffer.byteLength(serialized, 'utf8');
    if (byteLength > this.maxEventBytes) throw new RealtimeError('input_too_large', 'Realtime input is too large.');
    const bufferedAmount = this._socket.bufferedAmount;
    if (Number.isFinite(bufferedAmount) && bufferedAmount >= 0 && bufferedAmount + byteLength > this.maxEventBytes) {
      throw new RealtimeError('backpressure', 'Realtime socket is congested.');
    }
    const result = this._socket.send(serialized);
    if (result && typeof result.then === 'function') await result;
  }

  _protocolFault(code, message) {
    if (this._state === 'closed') return;
    const error = new RealtimeError(code, message);
    this._rejectOutputWaiter(error);
    this._emit({ type: 'error', code: error.code, message: error.message });
    if (this._startReject) {
      this._startReject(error);
      this._startReject = null;
      this._startResolve = null;
    }
    this._closeReason = code;
    this._state = 'closing';
    this._phase = 'closing';
    try { this._socket?.close(); } catch { /* already closed */ }
    this._forceClosed(code);
  }

  _forceClosed(reason) {
    if (this._state === 'closed') return;
    this._clearTimer();
    this._rejectOutputWaiter(new RealtimeError('connection_closed', 'Realtime connection closed.'));
    if (this._startReject) {
      this._startReject(new RealtimeError('connection_closed', 'Realtime connection closed.'));
      this._startReject = null;
      this._startResolve = null;
    }
    this._state = 'closed';
    this._phase = 'closed';
    this._socketOpen = false;
    try { this._socket?.close(); } catch { /* already closed */ }
    const result = { type: 'closed', reason: normalizeReason(reason, 'connection_closed') };
    if (this._closeResolve) this._closeResolve(result);
    this._closeResolve = null;
    this._emit(result);
  }

  _armTimer(callback, timeoutMs = this.timeoutMs) {
    this._clearTimer();
    this._timer = setTimeout(() => {
      this._timer = null;
      callback();
    }, timeoutMs);
  }

  _clearTimer() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  _waitForOutput() {
    if (this._outputWaiter) throw new RealtimeError('input_busy', 'Realtime input is still being processed.');
    return new Promise((resolve, reject) => {
      this._outputWaiter = { resolve, reject, responseId: null };
      this._outputTimer = setTimeout(() => {
        this._outputTimer = null;
        this._protocolFault('output_timeout', 'Realtime model output timed out.');
      }, this.outputTimeoutMs);
    });
  }

  _cancelOutputWaiter() {
    if (this._outputTimer) clearTimeout(this._outputTimer);
    this._outputTimer = null;
    this._outputWaiter = null;
  }

  _resolveOutputWaiter(responseId) {
    const waiter = this._outputWaiter;
    if (!waiter) return;
    this._cancelOutputWaiter();
    waiter.resolve({ responseId: responseId || '' });
  }

  _acceptOutputDelta(responseId) {
    const waiter = this._outputWaiter;
    if (!waiter) throw new RealtimeError('protocol_order', 'Unexpected output event.');
    if (waiter.responseId && waiter.responseId !== responseId) {
      throw new RealtimeError('protocol_order', 'Mismatched realtime response.');
    }
    waiter.responseId = responseId;
  }

  _rejectOutputWaiter(error) {
    const waiter = this._outputWaiter;
    if (!waiter) return;
    this._cancelOutputWaiter();
    waiter.reject(error);
  }

  _emit(event) {
    if (!event) return;
    for (const handler of [...this._handlers]) {
      try { handler(event); } catch { /* subscriber failure must not break transport */ }
    }
  }
}

class FakeRealtimeClient {
  constructor(options = {}) {
    const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
    if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < 4 || maxChunkBytes > 16 * 1024 * 1024) throw new TypeError('maxChunkBytes is invalid.');
    this.maxChunkBytes = maxChunkBytes;
    this.replyText = boundedString(options.replyText, MAX_TEXT_CHARS, { multiline: true }) || 'This is a local realtime demo response.';
    this._handlers = new Set();
    this._state = 'idle';
    this._sessionId = null;
    this._counter = 0;
    this._chain = Promise.resolve();
    this._audio = Buffer.alloc(Math.min(480, Math.floor(maxChunkBytes / 4)) * 4);
  }

  get state() { return this._state; }

  onEvent(handler) {
    if (typeof handler !== 'function') throw new TypeError('handler is required.');
    this._handlers.add(handler);
    return () => this._handlers.delete(handler);
  }

  async start(init = {}) {
    validateInit(init, 'duplex');
    if (this._state === 'ready') return { type: 'ready', sessionId: this._sessionId };
    if (this._state !== 'idle') throw new RealtimeError('closed', 'Realtime session is closed.');
    this._state = 'ready';
    this._sessionId = 'fake-session';
    await Promise.resolve();
    this._emit({ type: 'ready', sessionId: this._sessionId });
    return { type: 'ready', sessionId: this._sessionId };
  }

  append(input) {
    try { validateInput(input, this.maxChunkBytes); } catch (error) { return Promise.reject(error); }
    const task = this._chain.then(async () => {
      if (this._state !== 'ready') throw new RealtimeError('not_ready', 'Realtime session is not ready.');
      await Promise.resolve();
      const responseId = `fake-response-${++this._counter}`;
      this._emit({ type: 'text', text: this.replyText, responseId });
      this._emit({ type: 'audio', audio: this._audio.toString('base64'), sampleRate: 24_000, responseId });
      this._emit({ type: 'listen' });
      return { responseId };
    });
    this._chain = task.catch(() => undefined);
    return task;
  }

  async stop(reason = 'user_stop') {
    const normalizedReason = normalizeReason(reason, 'user_stop');
    if (this._state === 'closed' || this._state === 'idle') {
      this._state = 'closed';
      return { type: 'closed', reason: normalizedReason };
    }
    this._state = 'closed';
    await Promise.resolve();
    const event = { type: 'closed', reason: normalizedReason };
    this._emit(event);
    return event;
  }

  _emit(event) {
    for (const handler of [...this._handlers]) {
      try { handler(event); } catch { /* subscriber failure must not break fake transport */ }
    }
  }
}

module.exports = {
  DEFAULT_REALTIME_CLOSE_TIMEOUT_MS,
  DEFAULT_REALTIME_OUTPUT_TIMEOUT_MS,
  DEFAULT_REALTIME_TIMEOUT_MS,
  RealtimeClient,
  FakeRealtimeClient,
  RealtimeError,
  validateInput,
  validateServerEvent
};
