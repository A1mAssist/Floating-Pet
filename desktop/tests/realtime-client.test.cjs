'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_REALTIME_CLOSE_TIMEOUT_MS,
  DEFAULT_REALTIME_OUTPUT_TIMEOUT_MS,
  DEFAULT_REALTIME_TIMEOUT_MS,
  RealtimeClient,
  FakeRealtimeClient,
  RealtimeError,
  validateInput
} = require('../src/realtime-client.cjs');

class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closed = false;
    this.listeners = new Map();
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.closed) return;
      this.readyState = 1;
      this.emit('open');
    });
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  send(value) {
    if (this.closed || this.readyState !== 1) throw new Error('closed');
    this.sent.push(JSON.parse(value));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    queueMicrotask(() => this.emit('close'));
  }

  emit(type, value = {}) {
    for (const handler of this.listeners.get(type) || []) handler(value);
  }

  message(value) {
    this.emit('message', { data: JSON.stringify(value) });
  }
}

function makeClient(options = {}) {
  FakeSocket.instances.length = 0;
  return new RealtimeClient({
    WebSocketImpl: FakeSocket,
    url: 'ws://127.0.0.1:18000/v1/realtime',
    timeoutMs: 100,
    maxChunkBytes: 1024,
    ...options
  });
}

test('rejects realtime PCM outside the normalized amplitude range', () => {
  const bytes = Buffer.alloc(4);
  bytes.writeFloatLE(2, 0);
  assert.throws(() => validateInput({ audio: bytes.toString('base64') }, 1024), /audio is invalid/);
  assert.throws(() => validateInput({ audio: 'AAAAAA==', forceListen: 'yes' }, 1024), /forceListen is invalid/);
});

test('caps realtime JPEG frames at the service 1 MiB limit', () => {
  const audio = Buffer.alloc(4).toString('base64');
  const boundary = Buffer.alloc(1024 * 1024);
  boundary.set([0xff, 0xd8, 0xff]);
  assert.equal(validateInput({ audio, videoFrames: [boundary.toString('base64')] }, 2 * 1024 * 1024).video_frames.length, 1);

  const oversized = Buffer.alloc(1024 * 1024 + 1);
  oversized.set([0xff, 0xd8, 0xff]);
  assert.throws(
    () => validateInput({ audio, videoFrames: [oversized.toString('base64')] }, 2 * 1024 * 1024),
    /videoFrames\[0\] is invalid/
  );
});

test('uses a handshake timeout that covers the service prepare limit', () => {
  const client = new RealtimeClient({
    WebSocketImpl: FakeSocket,
    url: 'ws://127.0.0.1:18000/v1/realtime'
  });
  assert.equal(DEFAULT_REALTIME_TIMEOUT_MS, 35_000);
  assert.equal(DEFAULT_REALTIME_CLOSE_TIMEOUT_MS, 10_000);
  assert.equal(DEFAULT_REALTIME_OUTPUT_TIMEOUT_MS, 130_000);
  assert.equal(client.timeoutMs, DEFAULT_REALTIME_TIMEOUT_MS);
  assert.equal(client.closeTimeoutMs, DEFAULT_REALTIME_CLOSE_TIMEOUT_MS);
  assert.equal(client.outputTimeoutMs, DEFAULT_REALTIME_OUTPUT_TIMEOUT_MS);
});

async function handshake(client, init = { systemPrompt: 'hello', mode: 'duplex' }) {
  const start = client.start(init);
  await new Promise((resolve) => setImmediate(resolve));
  const socket = FakeSocket.instances[0];
  socket.message({ type: 'session.queue_done' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.sent[0], {
    type: 'session.init',
    payload: { mode: 'duplex', system_prompt: 'hello' }
  });
  socket.message({ type: 'session.created', session_id: 's1', mode: 'duplex' });
  await start;
  return socket;
}

test('follows queue_done -> init -> created and exposes a ready event', async () => {
  const client = makeClient();
  const events = [];
  client.onEvent((event) => events.push(event));
  const socket = await handshake(client);
  assert.deepEqual(events, [{ type: 'ready', sessionId: 's1' }]);
  assert.equal(socket.url, 'ws://127.0.0.1:18000/v1/realtime');
});

test('normalizes text, audio and listen deltas and validates metadata', async () => {
  const client = makeClient();
  const events = [];
  client.onEvent((event) => events.push(event));
  const socket = await handshake(client);
  const appended = client.append({ audio: 'AAAAAA==' });
  await new Promise((resolve) => setImmediate(resolve));
  socket.message({ type: 'response.output.delta', kind: 'text', response_id: 'r1', text: 'hello', is_listen: false, end_of_turn: false, current_time: 1.25 });
  socket.message({ type: 'response.output.delta', kind: 'audio', response_id: 'r1', audio: 'AAAAAA==', sample_rate: 24000 });
  socket.message({ type: 'response.output.delta', kind: 'listen', response_id: 'r1' });
  socket.message({ type: 'response.done', response_id: 'r1' });
  await appended;
  assert.deepEqual(events, [
    { type: 'ready', sessionId: 's1' },
    { type: 'text', text: 'hello', responseId: 'r1' },
    { type: 'audio', audio: 'AAAAAA==', sampleRate: 24000, responseId: 'r1' },
    { type: 'listen' }
  ]);
});

test('accepts MessageEvent data inherited from its prototype', async () => {
  const client = makeClient();
  const events = [];
  client.onEvent((event) => events.push(event));
  const socket = await handshake(client);
  const appended = client.append({ audio: 'AAAAAA==' });
  await new Promise((resolve) => setImmediate(resolve));
  const event = Object.create({ data: JSON.stringify({ type: 'response.output.delta', kind: 'text', response_id: 'r1', text: 'line 1\nline 2' }) });
  socket.emit('message', event);
  socket.message({ type: 'response.done', response_id: 'r1' });
  await appended;
  assert.deepEqual(events.at(-1), { type: 'text', text: 'line 1\nline 2', responseId: 'r1' });
});

test('append converts camelCase input and drops deprecated forceListen from the wire payload', async () => {
  const client = makeClient();
  const socket = await handshake(client);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  const appended = client.append({ audio: 'AAAAAA==', videoFrames: [`data:image/jpeg;base64,${jpeg}`], forceListen: true, maxSliceNums: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.sent[1], {
    type: 'input.append',
    input: { audio: 'AAAAAA==', video_frames: [jpeg], max_slice_nums: 2 }
  });
  socket.message({ type: 'response.output.delta', kind: 'listen', response_id: 'r1' });
  socket.message({ type: 'response.done', response_id: 'r1' });
  assert.deepEqual(await appended, { responseId: 'r1' });
});

test('serializes concurrent appends and rejects after stop', async () => {
  const client = makeClient();
  const events = [];
  client.onEvent((event) => events.push(event));
  const socket = await handshake(client);
  const first = client.append({ audio: 'AAAAAA==' });
  const second = client.append({ audio: 'AAAAAA==' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.filter((event) => event.type === 'input.append').length, 1);
  socket.message({ type: 'response.output.delta', kind: 'text', response_id: 'r1', text: 'one' });
  socket.message({ type: 'response.output.delta', kind: 'audio', response_id: 'r1', audio: 'AAAAAA==' });
  socket.message({ type: 'response.output.delta', kind: 'listen', response_id: 'r1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.filter((event) => event.type === 'input.append').length, 1);
  socket.message({ type: 'response.done', response_id: 'r1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.filter((event) => event.type === 'input.append').length, 2);
  socket.message({ type: 'response.output.delta', kind: 'listen', response_id: 'r2' });
  socket.message({ type: 'response.done', response_id: 'r2' });
  assert.deepEqual(await Promise.all([first, second]), [{ responseId: 'r1' }, { responseId: 'r2' }]);
  assert.equal(socket.sent.filter((event) => event.type === 'input.append').length, 2);
  const stopping = client.stop('user_stop');
  socket.message({ type: 'session.closed', reason: 'user_stop' });
  await stopping;
  await assert.rejects(client.append({ audio: 'AAAAAA==' }), (error) => error.code === 'closed' || error.code === 'not_ready');
  assert.deepEqual(socket.sent.at(-1), { type: 'session.close', reason: 'user_stop' });
  assert.equal(events.filter((event) => event.type === 'closed').length, 1);
});

test('fails closed before sending when websocket backpressure is over the limit', async () => {
  const client = makeClient();
  const events = [];
  client.onEvent((event) => events.push(event));
  const socket = await handshake(client);
  socket.bufferedAmount = client.maxEventBytes;

  await assert.rejects(client.append({ audio: 'AAAAAA==' }), (error) => error.code === 'backpressure');
  assert.equal(socket.sent.some((event) => event.type === 'input.append'), false);
  assert.equal(socket.closed, true);
  assert.equal(events.some((event) => event.type === 'error' && event.code === 'backpressure'), true);
});

test('malformed and oversized events fail closed', async (t) => {
  await t.test('malformed json', async () => {
    const client = makeClient();
    const events = [];
    client.onEvent((event) => events.push(event));
    const socket = await handshake(client);
    socket.emit('message', { data: '{not-json' });
    assert.equal(events[1].type, 'error');
    assert.equal(events[1].code, 'malformed_event');
    assert.equal(socket.closed, true);
  });
  await t.test('oversized audio', async () => {
    const client = makeClient({ maxChunkBytes: 4 });
    const events = [];
    client.onEvent((event) => events.push(event));
    const socket = await handshake(client);
    const encoded = Buffer.alloc(8).toString('base64');
    socket.message({ type: 'response.output.delta', kind: 'audio', response_id: 'r1', audio: encoded });
    assert.equal(events[1].code, 'invalid_input');
    assert.equal(socket.closed, true);
  });
});

test('handshake timeout rejects start and closes the socket', async () => {
  const client = makeClient({ timeoutMs: 10 });
  const events = [];
  client.onEvent((event) => events.push(event));
  await assert.rejects(client.start({ mode: 'duplex' }), (error) => error instanceof RealtimeError && error.code === 'timeout');
  assert.equal(events.some((event) => event.type === 'error' && event.code === 'timeout'), true);
  assert.equal(FakeSocket.instances[0].closed, true);
});

test('restarts the full handshake timeout after queue_done for backend prepare', async () => {
  const timeoutMs = 100;
  const client = makeClient({ timeoutMs });
  const start = client.start({ mode: 'duplex' });
  const outcome = start.then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  await new Promise((resolve) => setImmediate(resolve));
  const socket = FakeSocket.instances[0];
  await new Promise((resolve) => setTimeout(resolve, 70));
  socket.message({ type: 'session.queue_done' });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.state, 'connecting');

  socket.message({ type: 'session.created', session_id: 's1' });
  assert.deepEqual(await start, { type: 'ready', sessionId: 's1' });
  assert.deepEqual(await outcome, { ok: true });
});

test('times out when backend prepare never creates a session', async () => {
  const client = makeClient({ timeoutMs: 20 });
  const start = client.start({ mode: 'duplex' });
  await new Promise((resolve) => setImmediate(resolve));
  const socket = FakeSocket.instances[0];
  socket.message({ type: 'session.queue_done' });

  await assert.rejects(start, (error) => error instanceof RealtimeError && error.code === 'timeout');
  assert.equal(socket.closed, true);
});

test('times out and closes when one input never produces model output', async () => {
  const client = makeClient({ outputTimeoutMs: 20 });
  const events = [];
  client.onEvent((event) => events.push(event));
  const socket = await handshake(client);

  await assert.rejects(
    client.append({ audio: 'AAAAAA==' }),
    (error) => error instanceof RealtimeError && error.code === 'output_timeout'
  );
  assert.equal(socket.closed, true);
  assert.equal(events.some((event) => event.type === 'error' && event.code === 'output_timeout'), true);
});

test('fails closed when a stale response.done tries to settle a newer input', async () => {
  const client = makeClient();
  const socket = await handshake(client);
  const first = client.append({ audio: 'AAAAAA==' });
  await new Promise((resolve) => setImmediate(resolve));
  socket.message({ type: 'response.output.delta', kind: 'listen', response_id: 'r1' });
  socket.message({ type: 'response.done', response_id: 'r1' });
  await first;

  const second = client.append({ audio: 'AAAAAA==' });
  await new Promise((resolve) => setImmediate(resolve));
  socket.message({ type: 'response.done', response_id: 'r1' });

  await assert.rejects(second, (error) => error instanceof RealtimeError && error.code === 'protocol_order');
  assert.equal(socket.closed, true);
});

test('stop during handshake ignores late events and preserves the close reason', async () => {
  const client = makeClient({ closeTimeoutMs: 100 });
  const start = client.start({ mode: 'duplex' });
  const stoppedStart = assert.rejects(start, (error) => error instanceof RealtimeError && error.code === 'stopped');
  await new Promise((resolve) => setImmediate(resolve));
  const socket = FakeSocket.instances[0];
  socket.message({ type: 'session.queue_done' });
  await new Promise((resolve) => setImmediate(resolve));

  const stopping = client.stop('user_stop');
  socket.message({ type: 'session.created', session_id: 'late' });
  socket.message({ type: 'response.output.delta', kind: 'text', response_id: 'late', text: 'late' });
  assert.equal(client.state, 'closing');
  socket.message({ type: 'session.closed', reason: 'user_stop' });

  await stoppedStart;
  assert.deepEqual(await stopping, { type: 'closed', reason: 'user_stop' });
});

test('stop ignores malformed late frames and preserves the close reason', async () => {
  const client = makeClient({ closeTimeoutMs: 100 });
  const events = [];
  client.onEvent((event) => events.push(event));
  const socket = await handshake(client);
  const stopping = client.stop('user_stop');

  socket.emit('message', { data: '{broken' });
  assert.equal(client.state, 'closing');
  assert.equal(events.some((event) => event.type === 'error'), false);
  socket.message({ type: 'session.closed', reason: 'backend_error' });

  assert.deepEqual(await stopping, { type: 'closed', reason: 'user_stop' });
});

test('stop uses an independent bounded close timeout', async () => {
  const client = makeClient({ timeoutMs: 1_000, closeTimeoutMs: 10 });
  const events = [];
  client.onEvent((event) => events.push(event));
  await handshake(client);
  const startedAt = Date.now();
  const closed = await client.stop('user_stop');
  assert.equal(closed.reason, 'user_stop');
  assert.equal(Date.now() - startedAt < 500, true);
  assert.equal(events.some((event) => event.type === 'error' && event.code === 'close_timeout'), true);
  assert.equal(client.state, 'closed');
});

test('FakeRealtimeClient matches the service ready and response event order', async () => {
  const client = new FakeRealtimeClient({ maxChunkBytes: 1024, replyText: 'fake' });
  const events = [];
  client.onEvent((event) => events.push(event));
  await client.start({ mode: 'duplex' });
  await client.append({ audio: 'AAAAAA==' });
  assert.deepEqual(events[0], { type: 'ready', sessionId: 'fake-session' });
  assert.deepEqual(events.slice(1, 3), [
    { type: 'text', text: 'fake', responseId: 'fake-response-1' },
    { type: 'audio', audio: events[2].audio, sampleRate: 24000, responseId: 'fake-response-1' }
  ]);
  assert.equal(Buffer.from(events[2].audio, 'base64').length % 4, 0);
  assert.equal(Buffer.from(events[2].audio, 'base64').length <= 1024, true);
  assert.deepEqual(events[3], { type: 'listen' });
  await client.stop();
  assert.deepEqual(events.at(-1), { type: 'closed', reason: 'user_stop' });
});
