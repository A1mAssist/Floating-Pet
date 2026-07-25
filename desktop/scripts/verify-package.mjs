import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAll } from '@electron/asar';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.resolve(process.argv[2] || path.join(root, 'release'));
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const required = [
  `Floating-Pet-Setup-${version}-x64.exe`,
  `Floating-Pet-Portable-${version}-x64.exe`,
  `Floating-Pet-${version}-x64.zip`
];

const entries = await readdir(release);
for (const name of required) {
  if (!entries.includes(name)) throw new Error(`Missing package artifact: ${name}`);
  const info = await stat(path.join(release, name));
  if (info.size < 1_000_000) throw new Error(`Package artifact is unexpectedly small: ${name}`);
}

const unpacked = path.join(release, 'win-unpacked');
const executable = path.join(unpacked, 'Floating Pet.exe');
const asar = path.join(unpacked, 'resources', 'app.asar');
await Promise.all([access(executable), access(asar)]);

const scratch = await mkdtemp(path.join(os.tmpdir(), 'floating-pet-verify-'));
try {
  const extracted = path.join(scratch, 'asar');
  extractAll(asar, extracted);
  const sourceFiles = [
    'src/main.cjs',
    'src/preload.cjs',
    'src/core.cjs',
    'src/model-client.cjs',
    'src/realtime-client.cjs',
    'dist/index.html',
    'dist/styles.css',
    'dist/app.js',
    'dist/core.js',
    'dist/realtime-playback.js',
    'dist/pet.svg',
    'dist/icons/captions.svg',
    'dist/icons/chevron-down.svg',
    'dist/icons/circle-stop.svg',
    'dist/icons/mic.svg',
    'dist/icons/monitor-up.svg',
    'dist/icons/moon.svg',
    'dist/icons/pause.svg',
    'dist/icons/play.svg',
    'dist/icons/power.svg',
    'dist/icons/send.svg',
    'dist/icons/settings.svg',
    'dist/icons/sparkles.svg',
    'dist/icons/video.svg',
    'dist/icons/volume-2.svg',
    'dist/icons/x.svg',
    'dist/icons/LUCIDE-LICENSE.txt',
    'build/tray.png',
    'LICENSE'
  ];
  for (const relative of [...sourceFiles, 'package.json']) await access(path.join(extracted, relative));
  for (const relative of sourceFiles) {
    const [sourceHash, packagedHash] = await Promise.all([hashFile(path.join(root, relative)), hashFile(path.join(extracted, relative))]);
    if (sourceHash !== packagedHash) throw new Error(`Packaged source is stale: ${relative}`);
  }

  for (const forbidden of ['tests', 'scripts', 'release-preview.png', 'release-realtime-preview.png']) {
    if (await exists(path.join(extracted, forbidden))) throw new Error(`Development-only path shipped in app.asar: ${forbidden}`);
  }

  const unpackedReport = await runSmoke(executable, 'win-unpacked');
  const portableReport = await runSmoke(path.join(release, required[1]), 'portable');

  console.log(`PASS package artifacts (${required.join(', ')})`);
  console.log(`PASS win-unpacked production smoke ${JSON.stringify(unpackedReport)}`);
  console.log(`PASS portable production smoke ${JSON.stringify(portableReport)}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(target) {
  return createHash('sha256').update(await readFile(target)).digest('hex');
}

async function runSmoke(target, label) {
  const smokeReport = path.join(scratch, `${label}-smoke.json`);
  const userData = path.join(scratch, `${label}-user-data`);
  const child = spawn(target, ['--smoke-report', smokeReport, `--user-data-dir=${userData}`], { windowsHide: true, stdio: 'ignore' });
  const [exitCode] = await Promise.all([waitForExit(child, 60_000), waitForFile(smokeReport, 60_000)]);
  if (exitCode !== 0) throw new Error(`${label} smoke process exited with code ${exitCode}`);
  const report = JSON.parse(await readFile(smokeReport, 'utf8'));
  if (report.exitCode !== 0
    || report.mediaCallsBeforeStart !== 0
    || report.phase !== 'IDLE_VISIBLE'
    || !Array.isArray(report.activeInputs)
    || report.activeInputs.length !== 0
    || report.shell?.transparent !== true
    || report.shell?.alwaysOnTop !== true
    || report.shell?.skipTaskbar !== true
    || report.shell?.clickThroughInitialized !== true
    || report.shell?.focusedAtReady !== false
    || report.shell?.testMode !== false) {
    throw new Error(`${label} production smoke failed: ${JSON.stringify(report)}`);
  }
  return report;
}

async function waitForFile(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(target)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Smoke report was not written within ${timeoutMs}ms: ${target}`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Packaged smoke process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}
