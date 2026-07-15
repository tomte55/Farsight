// packages/controller/test/transfer-worker-importmap.test.js
// Same regression guard as importmap.test.js, applied to the transfer-worker's
// UI-less renderer (packages/controller/src/transfer-worker/). Its
// <script type="importmap"> must cover every bare @farsight/shared/* specifier
// reachable from worker.js, and every mapped entry must resolve to a real
// vendored source file.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(__dirname, '../src/transfer-worker');

function extractImports(code) {
  const re = /import\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  const out = [];
  let m;
  while ((m = re.exec(code))) out.push(m[1]);
  return out;
}

// Walk the worker's module graph from worker.js, following relative imports,
// collecting every bare @farsight/shared/* specifier that Chromium must resolve.
function collectSharedSpecifiers(entryFile) {
  const seen = new Set();
  const shared = new Set();
  const stack = [entryFile];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const code = readFileSync(file, 'utf8');
    for (const spec of extractImports(code)) {
      if (spec.startsWith('@farsight/shared/')) shared.add(spec);
      else if (spec.startsWith('./') || spec.startsWith('../')) stack.push(resolve(dirname(file), spec));
    }
  }
  return shared;
}

function importMap(html) {
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  return m ? (JSON.parse(m[1]).imports || {}) : {};
}

test('transfer-worker import map covers every @farsight/shared specifier in its module graph', () => {
  const needed = collectSharedSpecifiers(resolve(workerDir, 'worker.js'));
  const provided = new Set(Object.keys(importMap(readFileSync(resolve(workerDir, 'index.html'), 'utf8'))));
  expect(needed.size).toBeGreaterThan(0); // sanity: the graph really uses shared modules
  const missing = [...needed].filter((s) => !provided.has(s));
  expect(missing).toEqual([]);
});

test('every @farsight/shared entry in the transfer-worker importmap uses the packaging-safe ../shared/*.js path with a real source', () => {
  const imports = importMap(readFileSync(resolve(workerDir, 'index.html'), 'utf8'));
  const entries = Object.entries(imports).filter(([k]) => k.startsWith('@farsight/shared/'));
  expect(entries.length).toBeGreaterThan(0);
  for (const [, value] of entries) {
    // Same vendored path as the visible renderer's importmap — resolves
    // identically in dev and in the packaged asar.
    expect(value).toMatch(/^\.\.\/shared\/[\w-]+\.js$/);
    const name = value.replace('../shared/', '');
    expect(existsSync(resolve(__dirname, '../../shared/src', name))).toBe(true);
  }
});

test('transfer-worker index.html loads worker.js as a module script', () => {
  const html = readFileSync(resolve(workerDir, 'index.html'), 'utf8');
  expect(html).toMatch(/<script type="module" src="\.\/worker\.js">/);
});
