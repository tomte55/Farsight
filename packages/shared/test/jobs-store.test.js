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

test('list returns all saved jobs and skips corrupt / non-json files', async () => {
  const dir = tmp();
  const store = createJobsStore({ dir });
  await store.save({ ...sample(), jobId: 'j1' });
  await store.save({ ...sample(), jobId: 'j2' });
  // A hand-mangled record and an unrelated file must not break enumeration.
  writeFileSync(join(dir, 'j3.json'), '{ not valid json');
  writeFileSync(join(dir, 'notes.txt'), 'ignore me');
  const ids = (await store.list()).map((j) => j.jobId).sort();
  expect(ids).toEqual(['j1', 'j2']);
});

test('list on a never-used store directory is an empty array', async () => {
  const store = createJobsStore({ dir: join(tmp(), 'sub', 'not-created-yet') });
  expect(await store.list()).toEqual([]);
});

test('remove deletes a job and is a no-op if it is already gone', async () => {
  const store = createJobsStore({ dir: tmp() });
  await store.save({ ...sample(), jobId: 'gone' });
  await store.remove('gone');
  expect(await store.load('gone')).toBeNull();
  await store.remove('gone'); // no throw
});
