import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ['index.html', 'style.css', 'owner.css']) {
  await copyFile(resolve(root, name), resolve(output, name));
}
const publicTypes = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.ttf', '.woff', '.woff2', '.txt', '.md']);
async function copyPublic(directory, destination, allowed) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !entry.isFile() || !allowed.has(extname(entry.name).toLowerCase())) continue;
    await copyFile(resolve(directory, entry.name), resolve(destination, entry.name));
  }
}
await copyPublic(resolve(root, 'src'), resolve(output, 'src'), new Set(['.js']));
await copyPublic(resolve(root, 'assets'), resolve(output, 'assets'), publicTypes);
console.log('Netlify public site built in dist/. APIs are deployed separately as Netlify Functions.');
