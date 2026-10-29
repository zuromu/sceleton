// Renders the SVG icons to PNG at every size Chrome needs.
// Usage: node dev/render-icons.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'extension', 'icons');
const big = readFileSync(join(here, 'icon.svg'), 'utf8');
const small = readFileSync(join(here, 'icon-small.svg'), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  const svg = size <= 32 ? small : big;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
  await page.screenshot({ path: join(out, `${size}.png`), omitBackground: true });
}
await browser.close();
console.log('icons written to', out);
