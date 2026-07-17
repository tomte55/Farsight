// SP3 jobs-store (spec §6.5): durable per-job JSON records. Temp-dir tests.
import { expect, test, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createJobsStore, JOB_STATES } from '../src/jobs-store.js';
import { nextJobState } from '../src/transfer-engine.js';

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

// Review finding (security, pre-existing): jobId is sender-chosen (the wire
// OFFER carries it) and jobPath() used to path-join it into a filename with no
// sanitization. A peer whose transfer the human accepts (they approve "let dad
// send photo.jpg", never seeing the jobId) could send jobId '../victim' and
// get an arbitrary-path .json write/overwrite primitive on the receiver's
// disk. transfer-protocol.js now rejects a malformed jobId at the wire
// boundary, but this store must be safe even if a caller (a bug elsewhere, a
// future code path) hands it an unvalidated id directly -- defense in depth.
test('save/load never escape the store dir for a traversal-shaped, absolute, or separator-bearing jobId', async () => {
  const dir = tmp();
  const store = createJobsStore({ dir });
  const outsideDir = tmp(); // sibling tmp dir -- would be the escape target
  const victimInOutside = join(outsideDir, 'victim.json');
  const victimAboveDir = join(dir, '..', 'victim.json');

  const attempts = [
    '../victim',            // classic relative traversal
    '..\\victim',           // Windows-style traversal
    join(outsideDir, 'victim'), // absolute path as the "id"
    'sub/victim',           // forward-slash separator
    'sub\\victim',          // backslash separator
  ];

  for (const jobId of attempts) {
    await expect(store.save({ ...sample(), jobId })).rejects.toThrow();
    expect(await store.load(jobId)).toBeNull();
  }

  // Nothing landed outside `dir` from any attempt.
  expect(existsSync(victimAboveDir)).toBe(false);
  expect(existsSync(victimInOutside)).toBe(false);
  expect(existsSync(join(outsideDir, 'victim.json'))).toBe(false);
  // And `dir` itself only ever got legitimately-named files, if any at all.
  expect(readdirSync(dir).every((n) => !n.includes('/') && !n.includes('\\'))).toBe(true);
});

test('remove never escapes the store dir for a traversal-shaped jobId (no-op, does not throw)', async () => {
  const dir = tmp();
  const store = createJobsStore({ dir });
  const outsideDir = tmp();
  writeFileSync(join(outsideDir, 'victim.json'), JSON.stringify({ untouched: true }));

  await store.remove('../' + basename(outsideDir) + '/victim');
  expect(existsSync(join(outsideDir, 'victim.json'))).toBe(true); // untouched
});

test('JOB_STATES covers every state the engine reducer can reach', () => {
  const events = ['pause', 'resume', 'disconnect', 'reconnect', 'complete', 'fail', 'cancel', 'retry'];
  const reachable = new Set(['active']); // the initial state
  for (const s of [...JOB_STATES]) for (const e of events) reachable.add(nextJobState(s, e));
  for (const s of reachable) expect(JOB_STATES).toContain(s);
});

test('concurrent saves for the SAME jobId never publish a corrupt record', async () => {
  // A cancel racing the start-save writes the same jobId twice at once. With a
  // shared `${target}.tmp` both writes truncate/interleave one file and a rename
  // can publish it half-written — and a corrupt record is the worst outcome
  // possible here: list() skips it and load() returns null, so the job vanishes
  // from the Transfers list permanently. (Measured pre-fix: 74/120 corrupt.)
  const store = createJobsStore({ dir: tmp() });
  const jobId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const big = { jobId, dir: 'send', tier: 'fleet', manifest: { entries: Array.from({ length: 400 }, (_, i) => ({ fileId: i, path: `f${i}.bin`, size: 1024, mtime: 1 })) } };

  for (let round = 0; round < 40; round += 1) {
    await Promise.all([
      store.save({ ...big, jobState: 'active' }),
      store.save({ ...big, jobState: 'canceled' }),
    ]);
    const rec = await store.load(jobId);
    expect(rec).not.toBeNull();                       // never corrupt -> never "not found"
    expect(['active', 'canceled']).toContain(rec.jobState); // always one whole write, never a blend
    expect(rec.manifest.entries.length).toBe(400);
  }
  expect((await store.list()).length).toBe(1); // and no stray tmp/duplicate records
});
