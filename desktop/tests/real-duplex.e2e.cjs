'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { RealtimeClient } = require('../src/realtime-client.cjs');

const endpoint = process.env.FLOATING_PET_REALTIME_URL || 'ws://127.0.0.1:18000/v1/realtime';
const pcmPath = process.env.FLOATING_PET_REALTIME_PCM;
const framePath = process.env.FLOATING_PET_REALTIME_JPEG;
const handshakeTimeoutMs = Number(process.env.FLOATING_PET_REALTIME_TIMEOUT_MS || 60_000);
const outputTimeoutMs = Number(process.env.FLOATING_PET_REALTIME_OUTPUT_TIMEOUT_MS || 130_000);
const chunkSamples = 17_600;

assert.ok(pcmPath, 'FLOATING_PET_REALTIME_PCM is required.');
assert.ok(framePath, 'FLOATING_PET_REALTIME_JPEG is required.');
assert.equal(Number.isInteger(handshakeTimeoutMs) && handshakeTimeoutMs >= 1 && handshakeTimeoutMs <= 300_000, true, 'Handshake timeout is invalid.');
assert.equal(Number.isInteger(outputTimeoutMs) && outputTimeoutMs >= 1 && outputTimeoutMs <= 300_000, true, 'Output timeout is invalid.');
const pcm = fs.readFileSync(pcmPath);
const jpeg = fs.readFileSync(framePath);
assert.equal(pcm.length > 0 && pcm.length % 4 === 0, true, 'PCM must be non-empty little-endian float32.');
assert.deepEqual([...jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff], 'Video fixture must be JPEG.');
for (let offset = 0; offset < pcm.length; offset += 4) {
  assert.equal(Number.isFinite(pcm.readFloatLE(offset)), true, 'PCM contains a non-finite sample.');
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, error) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (error()) throw error();
    if (predicate()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for realtime model output.');
}

function amplitude(encoded) {
  const bytes = Buffer.from(encoded, 'base64');
  let max = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    max = Math.max(max, Math.abs(bytes.readFloatLE(offset)));
  }
  return { bytes: bytes.length, max };
}

function chunks() {
  const size = chunkSamples * 4;
  const result = [];
  for (let offset = 0; offset < pcm.length; offset += size) result.push(pcm.subarray(offset, offset + size));
  const silence = Buffer.alloc(size);
  return [...result, silence, silence, silence];
}

async function run(mode) {
  const url = new URL(endpoint);
  url.searchParams.set('mode', mode);
  const events = [];
  let failure;
  const client = new RealtimeClient({
    url: url.toString(),
    mode,
    timeoutMs: handshakeTimeoutMs,
    outputTimeoutMs,
    closeTimeoutMs: 10_000,
    maxChunkBytes: 512 * 1024
  });
  client.onEvent((event) => {
    events.push({ at: Date.now(), event });
    if (event.type === 'error') failure = new Error(`${event.code}: ${event.message}`);
  });

  const startedAt = Date.now();
  let firstInputAt;
  try {
    await client.start({ mode, systemPrompt: 'Reply briefly in Chinese and generate speech when appropriate.' });
    const readyAt = Date.now();
    for (const [index, chunk] of chunks().entries()) {
      if (events.some(({ event }) => event.type === 'text')
          && events.some(({ event }) => event.type === 'audio' && amplitude(event.audio).max > 0.0001)) break;
      const eventOffset = events.length;
      firstInputAt ||= Date.now();
      await client.append({
        audio: chunk.toString('base64'),
        videoFrames: mode === 'video' && index === 0 ? [`data:image/jpeg;base64,${jpeg.toString('base64')}`] : []
      });
      await waitFor(
        () => events.slice(eventOffset).some(({ event }) => ['listen', 'text', 'audio'].includes(event.type)),
        outputTimeoutMs,
        () => failure
      );
      await delay(100);
    }

    const textEvent = events.find(({ event }) => event.type === 'text');
    const audioEvents = events
      .filter(({ event }) => event.type === 'audio')
      .map((item) => ({ ...item, ...amplitude(item.event.audio) }));
    const audibleEvent = audioEvents.find((item) => item.max > 0.0001);
    assert.ok(textEvent, `${mode} produced no text.`);
    assert.ok(audibleEvent, `${mode} produced no non-silent PCM.`);

    const stopAt = Date.now();
    const closed = await client.stop(`${mode}_real_complete`);
    return {
      mode,
      prepare_ms: readyAt - startedAt,
      first_text_ms: textEvent.at - firstInputAt,
      first_audio_ms: audibleEvent.at - firstInputAt,
      close_ms: Date.now() - stopAt,
      close_reason: closed.reason,
      text: textEvent.event.text,
      audio_chunks: audioEvents.length,
      audio_bytes: audioEvents.reduce((total, item) => total + item.bytes, 0),
      max_amplitude: Math.max(...audioEvents.map((item) => item.max))
    };
  } finally {
    await client.stop('real_test_cleanup').catch(() => undefined);
  }
}

(async () => {
  const results = [];
  for (const mode of ['audio', 'video']) {
    const result = await run(mode);
    results.push(result);
    console.log(`PASS ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify(results, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
