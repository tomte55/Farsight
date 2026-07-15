// SP3 jobs-store (spec §6.5): durable per-job JSON records. Temp-dir tests.
import { expect, test, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobsStore } from '../src/jobs-store.js';

const dirs = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), 'ftjobs-')); dirs.push(d); return d; }
afterEach(() => { while (dirs.length) { try { rmSync(dirs.pop(), { recursive: true, force: true }); } catch {} } });

const sample = () => ({
  jobId: 'job-1', dir: 'recv', tier: 'adhoc', peer: { id: '306276549' },
  destRoot: '/tmp/dest',
  manifest: { entries: [{ fileId: 0, path: 'a.txt', size: 10, mtime: 1 }], totalBytes: 10, totalFiles: 1 },
  perFile: [{ fileId: 0, status: 'pending', hashLive: true }],
  jobState: 'active', createdAt: 1700000000000,
});

test('save then load round-trips a job with fileId kept numeric', async () => {
  const store = createJobsStore({ dir: tmp() });
  await store.save(sample());
  const got = await store.load('job-1');
  expect(got).toEqual(sample());
  expect(typeof got.perFile[0].fileId).toBe('number');
  expect(typeof got.manifest.entries[0].fileId).toBe('number');
});

test('save is atomic and leaves no temp files behind', async () => {
  const dir = tmp();
  const store = createJobsStore({ dir });
  await store.save(sample());
  const files = readdirSync(dir).sort();
  expect(files).toEqual(['job-1.json']);
});

test('load returns null for a missing job', async () => {
  const store = createJobsStore({ dir: tmp() });
  expect(await store.load('nope')).toBeNull();
});

test('save rejects a job without a string jobId', async () => {
  const store = createJobsStore({ dir: tmp() });
  await expect(store.save({ jobId: '' })).rejects.toThrow();
  await expect(store.save({})).rejects.toThrow();
});
