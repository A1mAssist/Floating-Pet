import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const harmonyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(harmonyRoot, '..');

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
