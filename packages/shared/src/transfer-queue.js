// packages/shared/src/transfer-queue.js
// SP3 coordination: filesystem-safe job ids, a serial single-active queue, and
// resume enumeration. Pure except newJobId (node:crypto). Spec §3.4/§6.5.
import { randomUUID } from 'node:crypto';

// Filesystem-safe (jobs-store derives a filename from this): lowercase hex only.
export function newJobId() { return randomUUID().replace(/-/g, ''); }

export const RESUMABLE_STATES = ['active', 'paused', 'interrupted'];

export function selectResumable(records) {
  if (!Array.isArray(records)) return [];
  return records
    .filter((r) => r && RESUMABLE_STATES.includes(r.jobState))
    .sort((a, b) => (a.createdAt - b.createdAt) || (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));
}
