import { cp, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'desktop', 'src');
const output = path.join(root, 'web-demo', 'dist');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(source, 'renderer'), output, { recursive: true });
await copyFile(path.join(source, 'core.cjs'), path.join(output, 'core.js'));
await copyFile(path.join(root, 'desktop', 'build', 'tray.png'), path.join(output, 'favicon.png'));
await copyFile(path.join(root, 'web-demo', 'web-adapter.js'), path.join(output, 'web-adapter.js'));
await copyFile(path.join(root, 'web-demo', 'web.css'), path.join(output, 'web.css'));

const indexPath = path.join(output, 'index.html');
const index = (await readFile(indexPath, 'utf8'))
  .replace('<title>Floating Pet</title>', '<title>Floating Pet</title>\n  <link rel="icon" type="image/png" href="favicon.png">')
  .replace('<link rel="stylesheet" href="styles.css">', '<link rel="stylesheet" href="styles.css">\n  <link rel="stylesheet" href="web.css">')
  .replace('<script src="core.js"></script>', '<script src="core.js"></script>\n  <script src="web-adapter.js"></script>');

if (!index.includes('favicon.png') || !index.includes('web.css') || !index.includes('web-adapter.js')) throw new Error('Web Demo assets were not injected');
await writeFile(indexPath, index, 'utf8');
console.log(`Built Web Demo at ${output}`);
