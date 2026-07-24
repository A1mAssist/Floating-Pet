import { cp, mkdir, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const renderer = path.join(root, 'src', 'renderer');
const iconSource = path.join(root, 'node_modules', 'lucide-static', 'icons');
const icons = [
  'captions', 'chevron-down', 'circle-stop', 'message-circle', 'mic', 'moon',
  'monitor-up', 'pause', 'play', 'power', 'send', 'settings', 'sparkles',
  'video', 'volume-2', 'x'
];

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, 'icons'), { recursive: true });
await cp(renderer, dist, { recursive: true });
await copyFile(path.join(root, 'src', 'core.cjs'), path.join(dist, 'core.js'));
for (const icon of icons) {
  await copyFile(path.join(iconSource, `${icon}.svg`), path.join(dist, 'icons', `${icon}.svg`));
}
console.log(`Built renderer and ${icons.length} Lucide icons.`);
