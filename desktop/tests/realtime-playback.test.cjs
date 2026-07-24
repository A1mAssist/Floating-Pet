'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BoundedAudioInputQueue,
  PcmPlayback,
  decodeFloat32Base64,
  encodeFloat32Base64,
  resampleFloat32,
  resumeAudioContext
} = require('../src/renderer/realtime-playback.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('bounded input queue preserves FIFO order with one active send', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const sent = [];
  let active = 0;
  let maxActive = 0;
  const queue = new BoundedAudioInputQueue(async (samples) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    sent.push([...samples]);
    try {
      await gates[sent.length - 1].promise;
    } finally {
      active -= 1;
    }
  });
  const first = new Float32Array([1]);
  const middle = new Float32Array([2]);
  const last = new Float32Array([3]);

  assert.equal(queue.push(first), true);
  assert.equal(queue.push(middle), true);
  assert.equal(queue.push(last), true);
  assert.deepEqual(sent, [[1]]);

  gates[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [[1], [2]]);
  gates[1].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [[1], [2], [3]]);
  gates[2].resolve();
  await queue.whenIdle();
  assert.equal(maxActive, 1);
  assert.deepEqual([[...first], [...middle], [...last]], [[0], [0], [0]]);
});

test('bounded input queue clears pending audio on stop', async () => {
  const gate = deferred();
  const sent = [];
  const queue = new BoundedAudioInputQueue((samples) => {
    sent.push(samples);
    return gate.promise;
  });
  const first = new Float32Array([1]);
  const pending = new Float32Array([2]);

  queue.push(first);
  queue.push(pending);
  queue.stop();
  assert.deepEqual([[...first], [...pending]], [[0], [0]]);
  gate.resolve();
  await queue.whenIdle();
  assert.deepEqual(sent, [first]);
});

test('bounded input queue reports overflow and clears retained audio', async () => {
  const gate = deferred();
  const errors = [];
  const first = new Float32Array([1]);
  const pending = new Float32Array([2]);
  const overflow = new Float32Array([3]);
  const queue = new BoundedAudioInputQueue(() => gate.promise, {
    maxBufferedChunks: 2,
    onError: (error) => errors.push(error.code)
  });

  assert.equal(queue.push(first), true);
  assert.equal(queue.push(pending), true);
  assert.equal(queue.push(overflow), false);
  assert.deepEqual(errors, ['audio_input_overflow']);
  assert.deepEqual([[...first], [...pending], [...overflow]], [[0], [0], [0]]);
  gate.resolve();
  await queue.whenIdle();
  assert.deepEqual([...first], [0]);
});

test('bounded input queue absorbs async overflow reporter failures', async () => {
  const gate = deferred();
  const queue = new BoundedAudioInputQueue(() => gate.promise, {
    maxBufferedChunks: 1,
    onError: async () => { throw new Error('report_failed'); }
  });

  assert.equal(queue.push(new Float32Array([1])), true);
  assert.equal(queue.push(new Float32Array([2])), false);
  await new Promise((resolve) => setImmediate(resolve));
  gate.resolve();
  await queue.whenIdle();
});

test('falls back cleanly when Web Audio is unavailable', async () => {
  const playback = new PcmPlayback({ AudioContextClass: null });
  assert.equal(await playback.enqueue(new Float32Array([0]), 24_000), false);
});

test('queues PCM through Web Audio and closes active sources', async () => {
  const calls = { buffers: [], starts: [], stops: 0, disconnects: 0, closes: 0 };
  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 1;
      this.destination = {};
    }

    createBuffer(channels, length, sampleRate) {
      const record = { channels, length, sampleRate, samples: null, channel: null };
      calls.buffers.push(record);
      return {
        copyToChannel(samples, channel) {
          record.samples = [...samples];
          record.channel = channel;
        }
      };
    }

    createBufferSource() {
      return {
        buffer: null,
        connect: (destination) => assert.equal(destination, this.destination),
        disconnect: () => { calls.disconnects += 1; },
        start: (at) => calls.starts.push(at),
        stop: () => { calls.stops += 1; },
        onended: null
      };
    }

    async close() {
      this.state = 'closed';
      calls.closes += 1;
    }
  }

  const playback = new PcmPlayback({ AudioContextClass: FakeAudioContext, maxQueuedSeconds: 0.05 });
  assert.equal(await playback.enqueue(new Float32Array([0.25, -0.5]), 24_000), true);
  assert.deepEqual(calls.buffers, [{ channels: 1, length: 2, sampleRate: 24_000, samples: [0.25, -0.5], channel: 0 }]);
  assert.deepEqual(calls.starts, [1]);
  assert.equal(await playback.enqueue(new Float32Array(2_400), 24_000), false);
  await playback.close();
  assert.equal(calls.stops, 1);
  assert.equal(calls.disconnects, 1);
  assert.equal(calls.closes, 1);
});

test('does not start a source when close wins a suspended context resume race', async () => {
  const resumeGate = deferred();
  const calls = { buffers: 0, sources: 0, starts: 0, closes: 0 };
  class SuspendedAudioContext {
    constructor() {
      this.state = 'suspended';
      this.currentTime = 0;
      this.destination = {};
    }

    resume() {
      return resumeGate.promise;
    }

    createBuffer() {
      calls.buffers += 1;
      return { copyToChannel() {} };
    }

    createBufferSource() {
      calls.sources += 1;
      return { connect() {}, disconnect() {}, start() { calls.starts += 1; } };
    }

    async close() {
      this.state = 'closed';
      calls.closes += 1;
    }
  }

  const playback = new PcmPlayback({ AudioContextClass: SuspendedAudioContext });
  const enqueue = playback.enqueue(new Float32Array([0.25]), 24_000);
  await playback.close();
  resumeGate.resolve();

  assert.equal(await enqueue, false);
  assert.deepEqual(calls, { buffers: 0, sources: 0, starts: 0, closes: 1 });
});

test('encodes and decodes little-endian float32 PCM', () => {
  const input = new Float32Array([-1, -0.25, 0, 0.5, 1]);
  assert.deepEqual([...decodeFloat32Base64(encodeFloat32Base64(input))], [...input]);
});

test('resamples one second of PCM to 16 kHz', () => {
  const input = new Float32Array(48_000).fill(0.25);
  const output = resampleFloat32(input, 48_000, 16_000);
  assert.equal(output.length, 16_000);
  assert.equal(output.every((sample) => sample === 0.25), true);
});

test('rejects malformed or non-finite PCM', () => {
  assert.throws(() => decodeFloat32Base64('AAAA'), /invalid_audio_length/);
  assert.throws(() => encodeFloat32Base64(new Float32Array([Number.NaN])), /invalid_audio_sample/);
});

test('bounds a suspended AudioContext resume', async () => {
  const context = { state: 'suspended', resume: () => new Promise(() => {}) };
  await assert.rejects(resumeAudioContext(context, 10), /audio_context_resume_timeout/);
});
