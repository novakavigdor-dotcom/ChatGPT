import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, resolve, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(root, '..');
const outputFile = resolve(outputDirectory, 'Umami-Passport.html');
const zipFile = resolve(outputDirectory, 'umami-passport.zip');
const moduleNames = ['loyalty', 'qr', 'owner', 'app'];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(fullPath));
    else if (entry.isFile()) result.push(fullPath);
  }
  return result;
}

const mimeTypes = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
};
const assets = [];
const bundledLicenses = [];
for (const asset of await walk(resolve(root, 'assets'))) {
  if (/(?:ofl|licen[cs]e|copying)[^/\\]*\.(?:txt|md)$/i.test(asset)) {
    bundledLicenses.push(`${relative(root, asset)}\n\n${await readFile(asset, 'utf8')}`);
  }
  const mime = mimeTypes[extname(asset).toLowerCase()];
  if (!mime) continue;
  assets.push({
    path: relative(root, asset).split('\\').join('/'),
    dataUrl: `data:${mime};base64,${(await readFile(asset)).toString('base64')}`,
  });
}

function embedAssets(source) {
  for (const asset of assets) {
    for (const prefix of ['./', '/', '']) source = source.split(prefix + asset.path).join(asset.dataUrl);
  }
  return source;
}

// Import maps retain each module's scope and its original export bindings.
// Asset URLs must be embedded before the modules become opaque data URLs.
const imports = {};
for (const name of moduleNames) {
  let source = embedAssets(await readFile(resolve(root, `src/${name}.js`), 'utf8'));
  source = source.replace(/(['"])\.\/(loyalty|qr|owner|app)\.js\1/g, (_, quote, dependency) => `${quote}umami/${dependency}${quote}`);
  if (/\bfrom\s*['"]\.{1,2}\//.test(source) || /\bimport\s*(?:\(\s*)?['"]\.{1,2}\//.test(source)) {
    throw new Error(`Standalone build found an unsupported relative module import in src/${name}.js.`);
  }
  imports[`umami/${name}`] = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

let html = embedAssets(await readFile(resolve(root, 'index.html'), 'utf8')).replace('<head>', '<head><meta name="umami-mode" content="offline">');
let inlinedStyle = false;
let inlinedOwnerStyle = false;
for (const name of ['style', 'owner']) {
  const pattern = new RegExp(`<link\\b[^>]*\\bhref=['"](?:\\.?\\/)?${name}\\.css['"][^>]*>`, 'i');
  if (!pattern.test(html)) {
    if (name === 'style') throw new Error('Unable to find style.css in index.html.');
    continue;
  }
  const css = embedAssets((await readFile(resolve(root, `${name}.css`), 'utf8'))
    .replace(/@import\s+url\(\s*(['"])https:\/\/fonts\.googleapis\.com\/[^'"]*\1\s*\)\s*;?/gi, ''));
  html = html.replace(pattern, () => `<style>\n${css}\n</style>`);
  if (name === 'style') inlinedStyle = true;
  else inlinedOwnerStyle = true;
}

let inlinedScript = false;
const importMap = JSON.stringify({ imports }).replace(/</g, '\\u003c');
html = html.replace(/<script\b[^>]*\bsrc=['"](?:\.?\/)?src\/app\.js['"][^>]*>\s*<\/script>/i, () => {
  inlinedScript = true;
  return `<script type="importmap">${importMap}</script>\n<script type="module">import 'umami/app';</script>`;
});
if (!inlinedStyle || !inlinedScript) throw new Error('Unable to find both application asset tags in index.html.');
if (!inlinedOwnerStyle) console.warn('owner.css was not linked in index.html; standalone owner styles were skipped.');

if (bundledLicenses.length) {
  const licenseText = bundledLicenses.join('\n\n---\n\n')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/<\/body>/i, () => `<template id="bundled-font-licenses"><pre>${licenseText}</pre></template>\n</body>`);
}
await writeFile(outputFile, html);
console.log(`Standalone demo: ${outputFile}`);

// Only source code and public assets belong in the download. The private data
// directory, .env files, Git metadata and server runtime files are never included.
const zipScript = `
import pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1]).resolve()
standalone = pathlib.Path(sys.argv[2])
archive = pathlib.Path(sys.argv[3])
individual = ['README.md', 'package.json', 'package-lock.json', 'netlify.toml', 'server.js', 'build.js', 'index.html', 'style.css', 'owner.css']
directories = {
    'src': {'.js'},
    'server': {'.js'},
    'scripts': {'.js'},
    'netlify': {'.js'},
    'assets': {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.ttf', '.woff', '.woff2', '.txt', '.md'},
    'test': {'.js'},
}
excluded = {'node_modules', 'umami-data', 'data'}
def safe(item):
    parts = item.relative_to(root).parts
    return (item.is_file() and not item.is_symlink() and item.resolve().is_relative_to(root)
            and not any(part.startswith('.') or part in excluded for part in parts))
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
    bundle.write(standalone, 'Umami-Passport.html')
    for name in individual:
        item = root / name
        if safe(item): bundle.write(item, 'source/' + str(item.relative_to(root)))
    for name, extensions in directories.items():
        source = root / name
        if not source.is_dir() or source.is_symlink(): continue
        for item in source.rglob('*'):
            if item.suffix.lower() in extensions and safe(item):
                bundle.write(item, 'source/' + str(item.relative_to(root)))
`;
const zipResult = spawnSync('python3', ['-c', zipScript, root, outputFile, zipFile], { encoding: 'utf8' });
if (zipResult.error || zipResult.status !== 0) {
  console.warn('ZIP could not be created. The standalone HTML app is ready.');
  if (zipResult.stderr) console.warn(zipResult.stderr.trim());
} else {
  console.log(`Download bundle: ${zipFile}`);
}
