'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { RealtimeClient, RealtimeError } = require('../src/realtime-client.cjs');

const endpoint = process.env.FLOATING_PET_REALTIME_URL || 'ws://127.0.0.1:18000/v1/realtime';
const pcmPath = process.env.FLOATING_PET_REALTIME_PCM;
const handshakeTimeoutMs = Number(process.env.FLOATING_PET_REALTIME_TIMEOUT_MS || 60_000);
const outputTimeoutMs = Number(process.env.FLOATING_PET_REALTIME_OUTPUT_TIMEOUT_MS || 130_000);
const soakSeconds = Number(process.env.FLOATING_PET_SOAK_SECONDS || 180);
const reconnects = Number(process.env.FLOATING_PET_RECONNECTS || 3);

assert.ok(pcmPath, 'FLOATING_PET_REALTIME_PCM is required.');
assert.equal(Number.isInteger(soakSeconds) && soakSeconds >= 10 && soakSeconds <= 3600, true, 'Soak duration is invalid.');
assert.equal(Number.isInteger(reconnects) && reconnects >= 1 && reconnects <= 20, true, 'Reconnect count is invalid.');
const pcm = fs.readFileSync(pcmPath).subarray(0, 16_000 * 4);
assert.equal(pcm.length, 16_000 * 4, 'PCM fixture must contain at least one second of 16 kHz float32 audio.');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function createClient(events) {
  const url = new URL(endpoint);
  url.searchParams.set('mode', 'audio');
  const client = new RealtimeClient({
    url: url.toString(),
    mode: 'audio',
    timeoutMs: handshakeTimeoutMs,
    outputTimeoutMs,
    closeTimeoutMs: 10_000,
    maxChunkBytes: 512 * 1024
  });
  client.onEvent((event) => events.push(event));
  return client;
}

async function startClient(label) {
  const events = [];
  const client = createClient(events);
  const startedAt = Date.now();
  await client.start({ mode: 'audio', systemPrompt: 'Reply briefly in Chinese.' });
  return { client, events, label, prepareMs: Date.now() - startedAt };
}

async function appendOnce(session) {
  const startedAt = Date.now();
  const result = await session.client.append({ audio: pcm.toString('base64') });
  return { responseId: result.responseId, latencyMs: Date.now() - startedAt };
}

async function closeSession(session, reason) {
  const startedAt = Date.now();
  const closed = await session.client.stop(reason);
  assert.equal(closed.reason, reason);
  assert.equal(session.events.some((event) => event.type === 'error'), false);
  return Date.now() - startedAt;
}

(async () => {
  const primary = await startClient('soak');
  const contenderEvents = [];
  const contender = createClient(contenderEvents);
  try {
    await assert.rejects(
      contender.start({ mode: 'audio', systemPrompt: 'Concurrent probe.' }),
      (error) => error instanceof RealtimeError && error.code === 'session_busy'
    );
  } catch (error) {
    await primary.client.stop('concurrency_probe_failed').catch(() => undefined);
    throw error;
  } finally {
    await contender.stop('concurrency_probe_complete').catch(() => undefined);
  }

  const deadline = Date.now() + soakSeconds * 1000;
  const latencies = [];
  const responseIds = new Set();
  try {
    while (Date.now() < deadline || latencies.length === 0) {
      const tick = Date.now();
      const result = await appendOnce(primary);
      latencies.push(result.latencyMs);
      responseIds.add(result.responseId);
      if (latencies.length % 10 === 0) console.log(`SOAK ${JSON.stringify({ appends: latencies.length })}`);
      await delay(Math.max(0, 1000 - (Date.now() - tick)));
    }
    assert.equal(responseIds.size, latencies.length);
  } finally {
    primary.closeMs = await closeSession(primary, 'soak_complete');
  }

  const reconnectResults = [];
  for (let index = 0; index < reconnects; index += 1) {
    const session = await startClient(`reconnect-${index + 1}`);
    try {
      const append = await appendOnce(session);
      reconnectResults.push({
        reconnect: index + 1,
        prepare_ms: session.prepareMs,
        append_ms: append.latencyMs,
        close_ms: await closeSession(session, `reconnect_${index + 1}_complete`)
      });
    } finally {
      await session.client.stop('reconnect_cleanup').catch(() => undefined);
    }
  }

  const result = {
    soak_seconds: soakSeconds,
    appends: latencies.length,
    prepare_ms: primary.prepareMs,
    append_p50_ms: percentile(latencies, 0.5),
    append_p95_ms: percentile(latencies, 0.95),
    append_max_ms: Math.max(...latencies),
    close_ms: primary.closeMs,
    concurrency: 'session_busy',
    reconnects: reconnectResults
  };
  console.log(`PASS ${JSON.stringify(result)}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
