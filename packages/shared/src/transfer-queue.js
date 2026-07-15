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

// Serial single-active FIFO. The head of the list is the active job; the rest
// wait. complete/remove drop the id and return the new active head (or null).
export function createQueue() {
  const order = []; // active is order[0]
  return {
    add(jobId) { if (!order.includes(jobId)) order.push(jobId); },
    active() { return order.length ? order[0] : null; },
    has(jobId) { return order.includes(jobId); },
    list() { return [...order]; },
    complete(jobId) { const i = order.indexOf(jobId); if (i >= 0) order.splice(i, 1); return order.length ? order[0] : null; },
    remove(jobId) { const i = order.indexOf(jobId); if (i >= 0) order.splice(i, 1); return order.length ? order[0] : null; },
  };
}
