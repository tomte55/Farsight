// packages/controller/test/session-window-importmap.test.js
// Same regression guard as importmap.test.js / transfer-worker-importmap.test.js,
// applied to the session window's renderer (packages/controller/src/session-window/).
// Its <script type="importmap"> must cover every bare @farsight/shared/* specifier
// reachable from session.js, and every mapped entry must resolve to a real
// vendored source file.
//
// NOTE: session.js does not exist yet (it lands in Task 3, which moves the
// connection logic out of renderer/renderer.js). Until then this file's importmap
// coverage/hash assertions are expected to FAIL — the CSP still carries
// 'sha256-PLACEHOLDER' (see index.html). This is documented, expected-red state;
// Task 3 finalizes session.js's shared-module graph and recomputes the hash.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(__dirname, '../src/session-window');

function extractImports(code) {
  const re = /import\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  const out = [];
  let m;
  while ((m = re.exec(code))) out.push(m[1]);
  return out;
}

// Walk the session window's module graph from session.js, following relative
// imports, collecting every bare @farsight/shared/* specifier that Chromium must
// resolve.
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

test('session-window import map covers every @farsight/shared specifier in its module graph', () => {
  const needed = collectSharedSpecifiers(resolve(workerDir, 'session.js'));
  const provided = new Set(Object.keys(importMap(readFileSync(resolve(workerDir, 'index.html'), 'utf8'))));
  expect(needed.size).toBeGreaterThan(0); // sanity: the graph really uses shared modules
  const missing = [...needed].filter((s) => !provided.has(s));
  expect(missing).toEqual([]);
});

test('every @farsight/shared entry in the session-window importmap uses the packaging-safe ../shared/*.js path with a real source', () => {
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

test('session-window index.html loads session.js as a module script', () => {
  const html = readFileSync(resolve(workerDir, 'index.html'), 'utf8');
  expect(html).toMatch(/<script type="module" src="\.\/session\.js">/);
});

// Regression guard for the v1.9.0 file-transfer failure, applied here: the session
// window's strict CSP (script-src 'self') BLOCKS its own inline
// <script type="importmap"> unless permitted, so session.js can't resolve
// @farsight/shared/* — the module never runs and no session ever starts. The
// importmap MUST be permitted by CSP. We pin it with a sha256 hash (keeping the
// session window's strict 'self' posture) and verify here that the hash in the CSP
// matches the actual importmap bytes — the browser hashes the element's text with
// HTML newline normalization (CRLF -> LF), so we normalize identically.
function importMapCspHash(html) {
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  if (!m) return null;
  const normalized = m[1].replace(/\r\n/g, '\n');
  return `sha256-${createHash('sha256').update(normalized, 'utf8').digest('base64')}`;
}
function cspContent(html) {
  const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/);
  return m ? m[1] : '';
}

test("session-window CSP permits its inline importmap (hash present) so session.js's module graph loads", () => {
  const html = readFileSync(resolve(workerDir, 'index.html'), 'utf8');
  const csp = cspContent(html);
  const scriptSrc = csp.split(';').map((s) => s.trim()).find((d) => d.startsWith('script-src'));
  expect(scriptSrc, 'index.html must declare a script-src directive').toBeTruthy();

  const hash = importMapCspHash(html);
  expect(hash).toBeTruthy();
  // The importmap must be allowed EITHER by its exact hash or 'unsafe-inline'.
  // We require the hash form: it keeps the window strictly self+this-one-script.
  expect(scriptSrc).toContain(`'${hash}'`);
  expect(scriptSrc).not.toContain("'unsafe-inline'"); // stay strict — hash only
});
