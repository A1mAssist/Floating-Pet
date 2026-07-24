'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { RealtimeClient } = require('../src/realtime-client.cjs');
const { BoundedAudioInputQueue, encodeFloat32Base64 } = require('../src/renderer/realtime-playback.js');

const endpoint = process.env.FLOATING_PET_REALTIME_URL || 'ws://127.0.0.1:18000/v1/realtime';
const pcmPath = process.env.FLOATING_PET_REALTIME_PCM;
const handshakeTimeoutMs = Number(process.env.FLOATING_PET_REALTIME_TIMEOUT_MS || 60_000);
const outputTimeoutMs = Number(process.env.FLOATING_PET_REALTIME_OUTPUT_TIMEOUT_MS || 130_000);
const runTimeoutMs = Number(process.env.FLOATING_PET_REALTIME_RUN_TIMEOUT_MS || 300_000);
const inputCount = 10;
const samplesPerChunk = 16_000;

assert.ok(pcmPath, 'FLOATING_PET_REALTIME_PCM is required.');
const bytes = fs.readFileSync(pcmPath);
assert.equal(bytes.length >= samplesPerChunk * 4 && bytes.length % 4 === 0, true, 'PCM fixture is too short.');
const source = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
const sourceChunkCount = Math.floor(source.length / samplesPerChunk);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTimeout(promise, timeoutMs, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function inputChunk(index) {
  const offset = (index % sourceChunkCount) * samplesPerChunk;
  const chunk = source.slice(offset, offset + samplesPerChunk);
  chunk[0] = (index + 1) / 1_000;
  return chunk;
}

(async () => {
  const events = [];
  let queueError = null;
  let sends = 0;
  let accepted = 0;
  let activeSends = 0;
  let maxConcurrentSends = 0;
  const sentMarkers = [];
  const responseIds = new Set();
  const startedAt = Date.now();
  const client = new RealtimeClient({
    url: new URL('/v1/realtime?mode=audio', endpoint).toString(),
    mode: 'audio',
    timeoutMs: handshakeTimeoutMs,
    outputTimeoutMs,
    closeTimeoutMs: 10_000,
    maxChunkBytes: 512 * 1024
  });
  client.onEvent((event) => events.push(event));

  try {
    await client.start({ mode: 'audio', systemPrompt: 'Reply briefly in Chinese.' });
    const readyAt = Date.now();
    console.log(`READY ${JSON.stringify({ prepare_ms: readyAt - startedAt })}`);
    const queue = new BoundedAudioInputQueue(
      async (samples) => {
        sends += 1;
        const send = sends;
        sentMarkers.push(Math.round(samples[0] * 1_000));
        activeSends += 1;
        maxConcurrentSends = Math.max(maxConcurrentSends, activeSends);
        const sendStartedAt = Date.now();
        try {
          const result = await client.append({ audio: encodeFloat32Base64(samples) });
          responseIds.add(result.responseId);
          console.log(`APPEND ${JSON.stringify({ send, output_ms: Date.now() - sendStartedAt })}`);
        } finally {
          activeSends -= 1;
        }
      },
      { onError: (error) => { queueError = error; } }
    );

    for (let index = 0; index < inputCount; index += 1) {
      if (queue.push(inputChunk(index))) accepted += 1;
      if (index + 1 < inputCount) await delay(1_000);
    }

    await withTimeout(queue.whenIdle(), runTimeoutMs, 'continuous_input_timeout');
    assert.equal(queueError, null);
    assert.equal(maxConcurrentSends, 1, 'Realtime sends must remain serialized.');
    assert.equal(accepted, inputCount, 'Every input chunk must enter the FIFO.');
    assert.equal(sends, inputCount, 'Every accepted input chunk must be sent.');
    assert.deepEqual(sentMarkers, Array.from({ length: inputCount }, (_, index) => index + 1), 'Audio chunks must retain FIFO identity and order.');
    assert.equal(responseIds.size, sends, 'Each send must complete with a unique matching response.');

    const closed = await client.stop('continuous_real_complete');
    assert.equal(closed.reason, 'continuous_real_complete');
    assert.equal(events.some((event) => event.type === 'error'), false);
    assert.equal(events.some((event) => event.code === 'input_backlog'), false);
    console.log(`PASS ${JSON.stringify({
      input_hz: 1,
      input_chunks: inputCount,
      sent_chunks: sends,
      accepted_chunks: accepted,
      sent_markers: sentMarkers,
      max_concurrent_sends: maxConcurrentSends,
      total_ms: Date.now() - startedAt,
      close_reason: closed.reason
    })}`);
  } finally {
    await client.stop('continuous_real_cleanup').catch(() => undefined);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
