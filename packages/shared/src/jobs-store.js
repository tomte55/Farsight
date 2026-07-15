// packages/shared/src/jobs-store.js
// SP3 (spec §6.5) MAIN-ONLY durable jobs store: one JSON file per job under `dir`.
// Atomic writes (temp + rename). No byte counters (the .part size is the offset),
// no secrets. Never imported by a renderer. perFile is an ARRAY so fileId stays numeric.
import { mkdir, writeFile, readFile, rename, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

function jobPath(dir, jobId) { return join(dir, `${jobId}.json`); }

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
        return null; // missing or corrupt
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
      await rm(jobPath(dir, jobId), { force: true });
    },
  };
}
