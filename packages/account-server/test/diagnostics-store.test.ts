import { expect, test } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createDiagnosticsStore } from '../src/diagnostics-store.js';

function fakeFs() {
  const files = new Map<string, Buffer>();
  return {
    files,
    existsSync: (p: string) => files.has(p) || p.endsWith('diag'),
    mkdirSync: () => {},
    writeFileSync: (p: string, d: Buffer) => { files.set(p, d as Buffer); },
    readdirSync: () => [...files.keys()].map((p) => p.split('/').pop()!),
    statSync: () => ({ isFile: () => true }),
    rmSync: (p: string) => { for (const k of files.keys()) if (k.endsWith(p.split('/').pop()!)) files.delete(k); },
  };
}

test('save writes a gzipped bundle and returns an id', () => {
  const fs = fakeFs();
  let t = 1_000_000;
  const store = createDiagnosticsStore({ dir: '/diag', fs: fs as any, gzipSync, now: () => t, ttlMs: 100, randomId: () => 'abc' });
  const { id } = store.save({ userId: 'u1', meta: { app: 'host' }, files: { 'main.log': 'hello' } });
  expect(id).toBe('abc');
  const [, buf] = [...fs.files.entries()][0];
  expect(JSON.parse(gunzipSync(buf).toString()).files['main.log']).toBe('hello');
});

test('prune removes files older than the ttl, keeps fresh ones', () => {
  const fs = fakeFs();
  let t = 1_000_000;
  const store = createDiagnosticsStore({ dir: '/diag', fs: fs as any, gzipSync, now: () => t, ttlMs: 100, randomId: () => 'old' });
  store.save({ userId: 'u1', meta: {}, files: {} }); // named …-1000000-old.json.gz
  t = 1_000_050; const fresh = createDiagnosticsStore({ dir: '/diag', fs: fs as any, gzipSync, now: () => t, ttlMs: 100, randomId: () => 'new' });
  fresh.save({ userId: 'u1', meta: {}, files: {} });
  t = 1_000_140; // old is now 140ms old (>100), new is 90ms (<100)
  expect(fresh.prune().removed).toBe(1);
  expect(fs.files.size).toBe(1);
});
