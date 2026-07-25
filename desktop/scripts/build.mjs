import { cp, mkdir, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const renderer = path.join(root, 'src', 'renderer');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(renderer, dist, { recursive: true });
await copyFile(path.join(root, 'src', 'core.cjs'), path.join(dist, 'core.js'));
console.log('Built renderer assets.');
