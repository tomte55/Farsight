// packages/host/test/importmap.test.js
// Regression guard: the Chromium renderer resolves bare `@farsight/shared/*`
// specifiers via the <script type="importmap"> in index.html. If any module in
// the renderer's graph imports a shared specifier that the map does not list,
// the whole renderer crashes on load ("Failed to resolve module specifier").
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rendererDir = resolve(__dirname, '../src/renderer');

function extractImports(code) {
  const re = /import\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  const out = [];
  let m;
  while ((m = re.exec(code))) out.push(m[1]);
  return out;
}

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

function importMapKeys(html) {
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  if (!m) return new Set();
  return new Set(Object.keys(JSON.parse(m[1]).imports || {}));
}

test('renderer import map covers every @farsight/shared specifier in the graph', () => {
  const needed = collectSharedSpecifiers(resolve(rendererDir, 'renderer.js'));
  const provided = importMapKeys(readFileSync(resolve(rendererDir, 'index.html'), 'utf8'));
  expect(needed.size).toBeGreaterThan(0);
  const missing = [...needed].filter((s) => !provided.has(s));
  expect(missing).toEqual([]);
});

function importMap(html) {
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  return m ? (JSON.parse(m[1]).imports || {}) : {};
}

test('every @farsight/shared entry uses the packaging-safe ../shared/*.js path with a real source', () => {
  const imports = importMap(readFileSync(resolve(rendererDir, 'index.html'), 'utf8'));
  const entries = Object.entries(imports).filter(([k]) => k.startsWith('@farsight/shared/'));
  expect(entries.length).toBeGreaterThan(0);
  for (const [, value] of entries) {
    // Must be the vendored path that resolves identically in dev and in the
    // packaged asar; the old ../../../shared/src/ path breaks once packaged.
    expect(value).toMatch(/^\.\.\/shared\/[\w-]+\.js$/);
    const name = value.replace('../shared/', '');
    expect(existsSync(resolve(__dirname, '../../shared/src', name))).toBe(true);
  }
});
