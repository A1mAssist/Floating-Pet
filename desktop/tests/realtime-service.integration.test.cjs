'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { RealtimeClient } = require('../src/realtime-client.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');
const JPEG_DATA_URL = `data:image/jpeg;base64,${[
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwc',
  'KDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy',
  'MjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcI',
  'CQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRol',
  'JicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ip',
  'qrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAA',
  'AAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLR',
  'ChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaX',
  'mJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEA',
  'PwDi6KKK+ZP3E//Z'
].join('')}`;

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(url, child, failureDetail) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const failure = failureDetail();
    if (failure || child.exitCode != null) throw new Error(`Fake realtime service exited early: ${failure}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.json()).capabilities?.realtime === true) return;
    } catch {
      // Uvicorn is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Fake realtime service did not become ready: ${failureDetail()}`);
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for realtime output.');
}

async function stopChild(child, timeoutMs = 2_000) {
  if (!child.pid || child.exitCode != null || child.signalCode != null) return;
  await new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
    };
    const onExit = () => {
      cleanup();
      resolve();
    };
    child.once('exit', onExit);
    timer = setTimeout(() => {
      cleanup();
      child.kill('SIGKILL');
      reject(new Error('Fake realtime service did not exit after termination.'));
    }, timeoutMs);
    if (!child.kill()) {
      cleanup();
      reject(new Error('Fake realtime service could not be terminated.'));
    }
  });
}

test('Node RealtimeClient interoperates with Python fake duplex audio and video modes', { timeout: 20_000 }, async () => {
  const port = await reservePort();
  const code = [
    'import os',
    'import uvicorn',
    'from service.minicpmo_server import create_app',
    "uvicorn.run(create_app(mode='duplex', fake_duplex=True), host='127.0.0.1', port=int(os.environ['MINICPM_TEST_PORT']), log_level='warning')"
  ].join(';');
  const child = spawn(process.env.PYTHON || 'python', ['-c', code], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MINICPM_PROTOCOL_TEST: '1',
      MINICPM_TEST_PORT: String(port)
    },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  let spawnError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
  child.once('error', (error) => { spawnError = error.message; });

  let client;
  try {
    await waitForHealth(`http://127.0.0.1:${port}/health`, child, () => spawnError || stderr);
    for (const scenario of [
      { mode: 'audio', videoFrames: [] },
      { mode: 'video', videoFrames: [JPEG_DATA_URL] }
    ]) {
      const events = [];
      client = new RealtimeClient({
        url: `ws://127.0.0.1:${port}/v1/realtime?mode=${scenario.mode}`,
        mode: scenario.mode,
        timeoutMs: 3_000,
        maxChunkBytes: 256 * 1024
      });
      client.onEvent((event) => events.push(event));

      const ready = await client.start({ mode: scenario.mode, systemPrompt: 'integration smoke' });
      assert.equal(ready.type, 'ready', `${scenario.mode} did not become ready`);
      await client.append({
        audio: Buffer.alloc(160 * 4).toString('base64'),
        videoFrames: scenario.videoFrames
      });
      await waitFor(() => ['listen', 'text', 'audio'].every((type) => events.some((event) => event.type === type)));

      const audio = events.find((event) => event.type === 'audio');
      assert.equal(audio.sampleRate, 24_000);
      assert.equal(Buffer.from(audio.audio, 'base64').length % 4, 0);
      const reason = `${scenario.mode}_integration_complete`;
      const closed = await client.stop(reason);
      assert.equal(closed.reason, reason);
      client = null;
    }
  } finally {
    await client?.stop('test_cleanup').catch(() => undefined);
    await stopChild(child);
  }
});
