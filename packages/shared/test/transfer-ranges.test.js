// packages/shared/test/transfer-ranges.test.js
import { describe, it, expect } from 'vitest';
import { createRangeSet } from '../src/transfer-ranges.js';

describe('transfer-ranges', () => {
  it('coalesces touching and overlapping adds', () => {
    const r = createRangeSet();
    r.add(0, 4);       // [0,4)
    r.add(4, 4);       // [4,8) touches -> [0,8)
    r.add(6, 5);       // [6,11) overlaps -> [0,11)
    expect(r.toJSON()).toEqual([[0, 11]]);
  });

  it('keeps disjoint intervals separate and ascending', () => {
    const r = createRangeSet();
    r.add(20, 5);
    r.add(0, 5);
    expect(r.toJSON()).toEqual([[0, 5], [20, 25]]);
  });

  it('covers only fully-covered ranges', () => {
    const r = createRangeSet([[0, 10]]);
    expect(r.covers(2, 5)).toBe(true);
    expect(r.covers(8, 5)).toBe(false); // extends to 13, uncovered past 10
  });

  it('computes gaps within a size, in order', () => {
    const r = createRangeSet([[0, 10], [20, 30]]);
    expect(r.gaps(35)).toEqual([
      { offset: 10, length: 10 },
      { offset: 30, length: 5 },
    ]);
  });

  it('isComplete only when [0,size) fully covered', () => {
    expect(createRangeSet([[0, 100]]).isComplete(100)).toBe(true);
    expect(createRangeSet([[0, 99]]).isComplete(100)).toBe(false);
    expect(createRangeSet([]).isComplete(0)).toBe(true);
    expect(createRangeSet([[0, 100]]).coveredBytes()).toBe(100);
  });

  it('re-adding covered bytes is idempotent (dead-flow requeue safety)', () => {
    const r = createRangeSet([[0, 50]]);
    r.add(10, 20); // already covered
    expect(r.toJSON()).toEqual([[0, 50]]);
    expect(r.coveredBytes()).toBe(50);
  });

  it('isComplete is true when [0,size) is covered even if extra intervals exist past size', () => {
    const r = createRangeSet([[0, 50], [60, 70]]);
    expect(r.isComplete(50)).toBe(true);   // [0,50) fully covered
    expect(r.gaps(50)).toEqual([]);        // and agrees with gaps()
  });
});
