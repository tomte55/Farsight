// packages/shared/src/jobs-store.js
// SP3 (spec §6.5) MAIN-ONLY durable jobs store: one JSON file per job under `dir`.
// Atomic writes (temp + rename). No byte counters (the .part size is the offset),
// no secrets. Never imported by a renderer. perFile is an ARRAY so fileId stays numeric.
import { mkdir, writeFile, readFile, rename, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

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
      await ensureDir();
      const target = jobPath(dir, job.jobId);
      const tmp = `${target}.tmp`;
      await writeFile(tmp, JSON.stringify(job), 'utf8');
      await rename(tmp, target); // atomic replace
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
        try { out.push(JSON.parse(await readFile(join(dir, n), 'utf8'))); } catch { /* skip corrupt */ }
      }
      return out;
    },
    async remove(jobId) {
      try { await rm(jobPath(dir, jobId), { force: true }); } catch { /* unsafe jobId: nothing to remove */ }
    },
  };
}
