// packages/shared/src/jobs-store.js
// SP3 (spec §6.5) MAIN-ONLY durable jobs store: one JSON file per job under `dir`.
// Atomic writes (temp + rename). No byte counters (the .part size is the offset),
// no secrets. Never imported by a renderer. perFile is an ARRAY so fileId stays numeric.
import { mkdir, writeFile, readFile, rename, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

// Monotonic suffix so queued writes never share a tmp path (see save()).
let writeSeq = 0;

// Serialize writes per jobId (see save()). The chain is dropped once it drains,
// so this can't grow with the number of jobs seen over a long-lived process.
const writeChains = new Map(); // jobId -> promise of the last queued write
function enqueueWrite(jobId, run) {
  const prev = writeChains.get(jobId);
  const next = (prev ? prev.then(run, run) : run());
  const tracked = next.catch(() => {}); // a failed write must not break the chain
  writeChains.set(jobId, tracked);
  tracked.then(() => { if (writeChains.get(jobId) === tracked) writeChains.delete(jobId); });
  return next; // callers still see their own write's error
}

// jobId is sender-chosen (transfer-protocol.js's OFFER carries it) and the
// RECEIVER path-joins it into a filename *after the human has already
// consented to the transfer* -- consent is "let dad send me photo.jpg", never
// "let dad choose an arbitrary filename on my disk". transfer-protocol.js
// rejects a malformed jobId at the wire boundary, but this store must be safe
// even if a caller (a test, a future code path, a bug elsewhere) hands it an
// unvalidated id directly -- defense in depth. Reject anything that isn't
// plain-filename-safe (no path separators, no '..'/'.' segment, no NUL) BEFORE
// it ever reaches a path-join, and additionally verify the resolved path is
// still inside `dir` -- belt and suspenders against any platform-specific
// separator/encoding we didn't think of.
function isSafeJobId(jobId) {
  if (typeof jobId !== 'string' || jobId.length === 0) return false;
  if (jobId === '.' || jobId === '..') return false;
  if (jobId.includes('/') || jobId.includes('\\') || jobId.includes('\0')) return false;
  return true;
}

function jobPath(dir, jobId) {
  if (!isSafeJobId(jobId)) throw new Error(`unsafe jobId: ${JSON.stringify(jobId)}`);
  const target = join(dir, `${jobId}.json`);
  // Belt and suspenders: the resolved path must still live directly inside
  // `dir` (not just "somewhere under it" -- jobId must not contain its own
  // separators, so this also guards against '..'-free but still surprising
  // resolutions on a platform we didn't anticipate).
  const resolvedDir = resolve(dir);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== join(resolvedDir, `${jobId}.json`) || !resolvedTarget.startsWith(resolvedDir + sep)) {
    throw new Error(`unsafe jobId: ${JSON.stringify(jobId)}`);
  }
  return target;
}

export const JOB_STATES = ['active', 'paused', 'interrupted', 'done', 'error', 'canceled'];

export function createJobsStore({ dir }) {
  let ensured = false;
  async function ensureDir() { if (!ensured) { await mkdir(dir, { recursive: true }); ensured = true; } }

  return {
    async save(job) {
      if (!job || typeof job.jobId !== 'string' || job.jobId.length === 0) {
        throw new Error('job requires a non-empty string jobId');
      }
      // Writes for one jobId are SERIALIZED. Two concurrent saves for the same
      // job (a cancel racing the start-save) are otherwise unsafe twice over: a
      // shared `${target}.tmp` gets truncated and interleaved by both writers,
      // and — measured on Windows — two concurrent renames onto the same target
      // throw EPERM, which the best-effort callers swallow, silently losing the
      // write. Either way the record can end up corrupt, and corrupt is the worst
      // outcome here: list() skips it and load() returns null, so the job would
      // vanish from the Transfers list permanently with nothing to clean it up.
      // Chaining keeps last-writer-wins (a cancel after a start still wins).
      return enqueueWrite(job.jobId, async () => {
        await ensureDir();
        const target = jobPath(dir, job.jobId);
        const tmp = `${target}.${writeSeq++}.tmp`; // unique: never collide with a queued write
        try {
          await writeFile(tmp, JSON.stringify(job), 'utf8');
          await rename(tmp, target); // atomic replace
        } catch (err) {
          await rm(tmp, { force: true }).catch(() => {}); // don't leave a stray tmp behind
          throw err;
        }
      });
    },
    async load(jobId) {
      try {
        const raw = await readFile(jobPath(dir, jobId), 'utf8');
        return JSON.parse(raw);
      } catch {
        return null; // missing, corrupt, or an unsafe jobId -- same "not found" shape
      }
    },
    async list() {
      await ensureDir();
      const out = [];
      let names;
      try { names = await readdir(dir); } catch { return out; }
      for (const n of names) {
        if (!n.endsWith('.json')) continue;
        try {
          out.push(JSON.parse(await readFile(join(dir, n), 'utf8')));
        } catch {
          // F-D3: never silently drop a corrupt record — a vanished job can't be
          // seen, resumed, or reaped. Surface a visible, reapable error marker.
          // (No `dir` field: this store is constructed with a path and doesn't know
          // the send/recv direction — that lives only in a valid record's own data.)
          out.push({ jobId: n.slice(0, -'.json'.length), corrupt: true, jobState: 'error' });
        }
      }
      return out;
    },
    async remove(jobId) {
      try { await rm(jobPath(dir, jobId), { force: true }); } catch { /* unsafe jobId: nothing to remove */ }
    },
  };
}
