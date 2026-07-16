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

test('save logs a diagnostics_saved event with id, userId, file count and byte size', () => {
  const fs = fakeFs();
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const store = createDiagnosticsStore({
    dir: '/diag', fs: fs as any, gzipSync, now: () => 1_000_000, ttlMs: 100, randomId: () => 'DIAG7F',
    log: (event, fields) => events.push({ event, fields }),
  });
  store.save({ userId: 'u1!weird/../', meta: {}, files: { 'main.log': 'a', 'main.log.1': 'b' } });
  const saved = events.find((e) => e.event === 'diagnostics_saved');
  expect(saved).toBeTruthy();
  expect(saved!.fields.id).toBe('DIAG7F');
  expect(saved!.fields.userId).toBe('u1weird'); // sanitized, no path chars
  expect(saved!.fields.files).toBe(2);
  expect(typeof saved!.fields.bytes).toBe('number');
  expect(saved!.fields.bytes as number).toBeGreaterThan(0);
});

test('prune logs a diagnostics_pruned event with the removed count', () => {
  const fs = fakeFs();
  let t = 1_000_000;
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const store = createDiagnosticsStore({
    dir: '/diag', fs: fs as any, gzipSync, now: () => t, ttlMs: 100, randomId: () => 'old',
    log: (event, fields) => events.push({ event, fields }),
  });
  store.save({ userId: 'u1', meta: {}, files: {} });
  t = 1_000_200; // now past the ttl
  store.prune();
  const pruned = events.find((e) => e.event === 'diagnostics_pruned');
  expect(pruned).toBeTruthy();
  expect(pruned!.fields.removed).toBe(1);
});
