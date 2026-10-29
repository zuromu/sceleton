// Makes a copy of the extension that talks to the fake SCeLE in dev/mock_scele.py
// instead of the real one. Output: dev/build/extension
//
//   node dev/build-dev.mjs
//   then load dev/build/extension in chrome://extensions (Developer mode, Load unpacked)

import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:8765';
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'extension');
const out = join(here, 'build', 'extension');

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });

const cfg = join(out, 'lib', 'config.js');
writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('https://scele.cs.ui.ac.id', MOCK));

const manifestPath = join(out, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const swap = (list) => list.map((m) => m.replace('https://scele.cs.ui.ac.id', MOCK));
manifest.name = 'Sceleton (dev)';
manifest.host_permissions = swap(manifest.host_permissions);
manifest.content_scripts.forEach((c) => { c.matches = swap(c.matches); });
manifest.web_accessible_resources.forEach((r) => { r.matches = swap(r.matches); });
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log(`Dev build ready at ${out} (SCeLE = ${MOCK})`);
