import http from 'node:http';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderQr } from '../src/qr.js';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '..');
const output = resolve(root, '..');
const applicationUrl = 'https://umamisushipassport.netlify.app/customer';

let playwright;
if (process.env.PLAYWRIGHT_MODULE) playwright = await import(process.env.PLAYWRIGHT_MODULE);
else {
  try { playwright = await import('playwright'); }
  catch {
    try { playwright = await import('playwright-core'); }
    catch { throw new Error('Rendering needs Playwright. Install it separately or set PLAYWRIGHT_MODULE to its absolute module path. The bingo app does not need it.'); }
  }
}

const posterPath = resolve(directory, 'poster.html');
let html = await readFile(posterPath, 'utf8');
const marker = /<!-- BINGO_QR_START -->[\s\S]*?<!-- BINGO_QR_END -->/;
if (!marker.test(html)) throw new Error('The poster QR placeholder is missing.');
html = html.replace(marker, () => `<!-- BINGO_QR_START -->${renderQr(applicationUrl, { size: 430, label: 'Start your Umami Bingo card' })}<!-- BINGO_QR_END -->`);
await writeFile(posterPath, html);

const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.ttf': 'font/ttf' };
const server = http.createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (path !== '/marketing/poster.html' && !/^\/assets\/[\w.-]+$/.test(path)) { response.writeHead(404); response.end(); return; }
  try {
    const data = await readFile(resolve(root, `.${path}`));
    response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' });
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await playwright.chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1398 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`Missing poster asset: ${new URL(response.url()).pathname}`); });
  await page.goto(`http://127.0.0.1:${server.address().port}/marketing/poster.html`);
  await page.evaluate(() => document.fonts.ready);
  if (errors.length) throw new Error(errors.join('\n'));
  await page.pdf({ path: resolve(output, 'Umami-Bingo-Poster.pdf'), preferCSSPageSize: true, printBackground: true });

  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => { document.documentElement.dataset.format = 'social'; });
  await page.setViewportSize({ width: 1080, height: 1350 });
  const qrRectangle = await page.locator('.qr').boundingBox();
  const footerBottom = await page.locator('.footer').evaluate((element) => element.getBoundingClientRect().bottom);
  if (!qrRectangle || footerBottom > 1350) throw new Error('The poster contents do not fit the social image.');
  const png = await page.screenshot({ path: resolve(output, 'Umami-Bingo-Ad.png') });
  const qrModule = `data:text/javascript;base64,${(await readFile(resolve(root, 'src/qr.js'))).toString('base64')}`;
  const decoded = await page.evaluate(async ({ source, moduleUrl, rectangle }) => {
    const { decodeQrImageData } = await import(moduleUrl);
    const image = new Image();
    await new Promise((done, reject) => { image.onload = done; image.onerror = reject; image.src = source; });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(rectangle.width);
    canvas.height = Math.ceil(rectangle.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, rectangle.x, rectangle.y, rectangle.width, rectangle.height, 0, 0, canvas.width, canvas.height);
    return decodeQrImageData(context.getImageData(0, 0, canvas.width, canvas.height));
  }, { source: `data:image/png;base64,${png.toString('base64')}`, moduleUrl: qrModule, rectangle: qrRectangle });
  if (decoded !== applicationUrl) throw new Error('The exported image QR did not decode to the customer signup address.');
  await copyFile(resolve(output, 'Umami-Bingo-Poster.pdf'), resolve(directory, 'Umami-Bingo-Poster.pdf'));
  await copyFile(resolve(output, 'Umami-Bingo-Ad.png'), resolve(directory, 'Umami-Bingo-Ad.png'));
  console.log('Exported one Letter poster PDF and a 1080×1350 social image. QR decoded to the customer signup address.');
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
