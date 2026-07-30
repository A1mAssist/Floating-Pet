import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const harmonyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(harmonyRoot, '..');
const bridgePath = path.join(harmonyRoot, 'entry', 'src', 'main', 'resources', 'rawfile', 'harmony-bridge.js');

function loadBridge(invoke) {
  const logs = [];
  const context = vm.createContext({
    console: {
      info: (value) => logs.push(String(value)),
      error: (value) => logs.push(String(value))
    },
    FloatPetNative: { invoke },
    setTimeout,
    clearTimeout
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(bridgePath, 'utf8'), context, { filename: bridgePath });
  return { context, logs };
}

test('formal HarmonyOS project no longer identifies itself as a mock', () => {
  const packageText = fs.readFileSync(path.join(harmonyRoot, 'entry', 'oh-package.json5'), 'utf8');
  assert.doesNotMatch(packageText, /mock/i);
});

test('platform-neutral renderer assets match desktop sources', () => {
  const result = spawnSync(process.execPath, [path.join(harmonyRoot, 'scripts', 'sync-renderer.mjs'), '--check'], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('Harmony bridge maps window.pet calls onto the single native proxy', async () => {
  const calls = [];
  const { context } = loadBridge(async (method, payloadJson) => {
    calls.push({ method, payload: JSON.parse(payloadJson) });
    const value = method === 'capture.frame'
      ? { dataUrl: 'data:image/jpeg;base64,/9j/', source: 'screen' }
      : method === 'capture.listSources'
        ? [{ id: 'display:0', name: '主屏幕' }]
        : true;
    return JSON.stringify({ ok: true, value });
  });

  assert.equal(context.pet.capture.nativeFrames, true);
  assert.equal(JSON.stringify(await context.pet.capture.listSources()), JSON.stringify([{ id: 'display:0', name: '主屏幕' }]));
  assert.equal((await context.pet.capture.frame()).source, 'screen');
  assert.equal(await context.pet.capture.selectSource('display:0'), true);
  assert.equal(JSON.stringify(calls), JSON.stringify([
    { method: 'capture.listSources', payload: {} },
    { method: 'capture.frame', payload: {} },
    { method: 'capture.selectSource', payload: { id: 'display:0' } }
  ]));
});

test('Harmony bridge rejects malformed and failed native envelopes', async () => {
  const malformed = loadBridge(async () => '{').context;
  await assert.rejects(malformed.pet.model.capabilities(), (error) => error.code === 'invalid_response');

  const failed = loadBridge(async () => JSON.stringify({
    ok: false,
    error: { code: 'permission_denied', message: '未授权。' }
  })).context;
  await assert.rejects(failed.pet.capture.listSources(), (error) => {
    assert.equal(error.code, 'permission_denied');
    assert.equal(error.message, '未授权。');
    return true;
  });
});

test('Harmony bridge routes native events and supports unsubscribe', () => {
  const { context } = loadBridge(async () => JSON.stringify({ ok: true, value: null }));
  const events = [];
  const unsubscribe = context.pet.realtime.onEvent((event) => events.push(event));
  assert.equal(context.__floatPetNativeEvent('realtime', { type: 'text', text: '你好' }), true);
  unsubscribe();
  context.__floatPetNativeEvent('realtime', { type: 'listen' });
  assert.equal(JSON.stringify(events), JSON.stringify([{ type: 'text', text: '你好' }]));
  assert.equal(context.__floatPetNativeEvent('unknown', {}), false);
});
