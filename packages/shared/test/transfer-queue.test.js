import { expect, test } from 'vitest';
import { newJobId, selectResumable, RESUMABLE_STATES } from '../src/transfer-queue.js';

test('newJobId is a filesystem-safe unique lowercase hex id', () => {
  const a = newJobId(), b = newJobId();
  expect(a).not.toBe(b);
  expect(a).toMatch(/^[0-9a-f]+$/); // no dashes, no path chars, no ':'
  expect(a.length).toBeGreaterThanOrEqual(16);
});

test('RESUMABLE_STATES are the incomplete states only', () => {
  expect(RESUMABLE_STATES).toEqual(['active', 'paused', 'interrupted']);
});

test('selectResumable keeps only incomplete jobs, ordered by createdAt then jobId', () => {
  const recs = [
    { jobId: 'c', jobState: 'done', createdAt: 1 },
    { jobId: 'a', jobState: 'interrupted', createdAt: 30 },
    { jobId: 'b', jobState: 'active', createdAt: 10 },
    { jobId: 'd', jobState: 'canceled', createdAt: 5 },
    { jobId: 'e', jobState: 'paused', createdAt: 10 },
    { jobId: 'f', jobState: 'error', createdAt: 2 },
  ];
  expect(selectResumable(recs).map((r) => r.jobId)).toEqual(['b', 'e', 'a']); // b&e tie at 10 → jobId order
});

test('selectResumable tolerates a non-array / empty input', () => {
  expect(selectResumable(null)).toEqual([]);
  expect(selectResumable([])).toEqual([]);
});
