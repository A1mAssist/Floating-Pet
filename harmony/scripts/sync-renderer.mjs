import { cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const harmonyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(harmonyRoot, '..');
const desktopRenderer = path.join(repositoryRoot, 'desktop', 'src', 'renderer');
const rawfile = path.join(harmonyRoot, 'entry', 'src', 'main', 'resources', 'rawfile');
const checkOnly = process.argv.includes('--check');

const mappings = [
  [path.join(desktopRenderer, 'app.js'), path.join(rawfile, 'app.js')],
  [path.join(repositoryRoot, 'desktop', 'src', 'core.cjs'), path.join(rawfile, 'core.js')],
  [path.join(desktopRenderer, 'realtime-playback.js'), path.join(rawfile, 'realtime-playback.js')],
  [path.join(desktopRenderer, 'pet.svg'), path.join(rawfile, 'pet.svg')],
  [path.join(desktopRenderer, 'icons'), path.join(rawfile, 'icons')],
  [path.join(desktopRenderer, 'vendor'), path.join(rawfile, 'vendor')]
];

async function filesEqual(source, destination) {
  try {
    const [left, right] = await Promise.all([readFile(source), readFile(destination)]);
    return left.equals(right);
  } catch {
    return false;
  }
}

async function collectFiles(root, relative = '') {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}

async function mappingMatches(source, destination) {
  const { stat } = await import('node:fs/promises');
  const info = await stat(source);
  if (info.isFile()) return filesEqual(source, destination);
  const files = await collectFiles(source);
  const checks = await Promise.all(files.map((file) => filesEqual(path.join(source, file), path.join(destination, file))));
  return checks.every(Boolean);
}

if (checkOnly) {
  const stale = [];
  for (const [source, destination] of mappings) {
    if (!await mappingMatches(source, destination)) stale.push(path.relative(repositoryRoot, destination));
  }
  if (stale.length) {
    console.error(`Harmony renderer assets are stale: ${stale.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('Harmony renderer assets match desktop sources.');
  }
} else {
  await mkdir(rawfile, { recursive: true });
  for (const [source, destination] of mappings) {
    await cp(source, destination, { recursive: true, force: true });
  }
  console.log('Synchronized platform-neutral renderer assets.');
}
