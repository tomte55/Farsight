import { expect, test } from 'vitest';
import { newJobId, selectResumable, RESUMABLE_STATES } from '../src/transfer-queue.js';
import { createQueue } from '../src/transfer-queue.js';

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

test('createQueue keeps one active job and promotes FIFO on complete', () => {
  const q = createQueue();
  expect(q.active()).toBeNull();
  q.add('j1'); q.add('j2'); q.add('j3');
  expect(q.active()).toBe('j1');
  expect(q.list()).toEqual(['j1', 'j2', 'j3']);
  expect(q.complete('j1')).toBe('j2'); // promotes next active
  expect(q.active()).toBe('j2');
  expect(q.list()).toEqual(['j2', 'j3']);
});

test('add is idempotent and remove drops a waiting or active job', () => {
  const q = createQueue();
  q.add('a'); q.add('a'); q.add('b');
  expect(q.list()).toEqual(['a', 'b']); // no duplicate
  expect(q.has('b')).toBe(true);
  expect(q.remove('b')).toBe('a'); // removing a waiting job keeps active 'a'
  expect(q.list()).toEqual(['a']);
  expect(q.remove('a')).toBeNull(); // removing the last leaves nothing active
  expect(q.active()).toBeNull();
});

test('completing a non-active job just drops it from the waiting list', () => {
  const q = createQueue();
  q.add('a'); q.add('b'); q.add('c');
  expect(q.complete('c')).toBe('a'); // active unchanged
  expect(q.list()).toEqual(['a', 'b']);
});

test('moveUp/moveDown reorder waiting jobs but never touch the active head', () => {
  const q = createQueue();
  ['a', 'b', 'c', 'd'].forEach((id) => q.add(id)); // a=active(0), b,c,d wait
  expect(q.moveUp('a')).toBe(false);           // head can't move
  expect(q.moveUp('b')).toBe(false);           // would land at index 0
  expect(q.moveDown('a')).toBe(false);         // head pinned
  expect(q.moveUp('c')).toBe(true);            // c swaps with b
  expect(q.list()).toEqual(['a', 'c', 'b', 'd']);
  expect(q.moveDown('c')).toBe(true);          // back down
  expect(q.list()).toEqual(['a', 'b', 'c', 'd']);
  expect(q.moveDown('d')).toBe(false);         // already last
  expect(q.moveUp('zzz')).toBe(false);         // not found
  expect(q.active()).toBe('a');                // head never changed
});
