import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = [
  'src/main.cjs', 'src/preload.cjs', 'src/core.cjs', 'src/model-client.cjs', 'src/realtime-client.cjs',
  'src/renderer/app.js', 'src/renderer/realtime-playback.js',
  'tests/core.test.cjs', 'tests/model-client.test.cjs', 'tests/realtime-client.test.cjs',
  'tests/realtime-playback.test.cjs', 'tests/realtime-service.integration.test.cjs',
  'tests/e2e.cjs', 'tests/real-model.e2e.cjs', 'scripts/build.mjs', 'scripts/verify-package.mjs'
];
for (const relative of scripts) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, relative)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const relative of [
  'src/renderer/index.html',
  'src/renderer/styles.css',
  'src/renderer/pet.svg',
  'src/renderer/icons/captions.svg',
  'src/renderer/icons/chevron-down.svg',
  'src/renderer/icons/circle-stop.svg',
  'src/renderer/icons/mic.svg',
  'src/renderer/icons/monitor-up.svg',
  'src/renderer/icons/moon.svg',
  'src/renderer/icons/pause.svg',
  'src/renderer/icons/play.svg',
  'src/renderer/icons/power.svg',
  'src/renderer/icons/send.svg',
  'src/renderer/icons/settings.svg',
  'src/renderer/icons/sparkles.svg',
  'src/renderer/icons/video.svg',
  'src/renderer/icons/volume-2.svg',
  'src/renderer/icons/x.svg',
  'src/renderer/icons/LUCIDE-LICENSE.txt'
]) {
  await access(path.join(root, relative));
}
const css = await readFile(path.join(root, 'src/renderer/styles.css'), 'utf8');
for (const forbidden of ['transition: all', 'ease-in;', 'scale(0)', 'linear-gradient', 'radial-gradient']) {
  if (css.includes(forbidden)) throw new Error(`Forbidden visual pattern: ${forbidden}`);
}
console.log('PASS syntax, assets, and motion guardrails');
