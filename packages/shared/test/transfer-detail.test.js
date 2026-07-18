// packages/shared/test/transfer-detail.test.js
// Task 10: pure formatting/state helpers for the expandable Transfer Detail UI
// (flow health, terminally-failed files + human reason, the aggregate bytes/
// rate/ETA/files line, and the verify-tail ETA/rate suppression fix).
import { describe, test, expect } from 'vitest';
import {
  reasonLabel, flowHealthLabel, upsertFailedFile, fileNameFor, isFinishingTail, aggregateDetail,
} from '../src/transfer-detail.js';

describe('reasonLabel', () => {
  test('maps the known io_error code to a human explanation', () => {
    expect(reasonLabel('io_error')).toBe("Couldn't write file (locked by another program?)");
  });

  test('falls back to the raw code for an unknown reason', () => {
    expect(reasonLabel('some_future_code')).toBe('some_future_code');
  });

  test('falsy/missing reason gets a generic label, not blank or "undefined"', () => {
    expect(reasonLabel(undefined)).toBe('Unknown error');
    expect(reasonLabel('')).toBe('Unknown error');
    expect(reasonLabel(null)).toBe('Unknown error');
  });
});

describe('flowHealthLabel', () => {
  test('renders live/total flows plus a re-dial count when redials > 0', () => {
    expect(flowHealthLabel({ flowsLive: 14, flowsTotal: 16, redials: 3 })).toBe('14/16 flows • 3 re-dials');
  });

  test('singular "re-dial" for exactly one', () => {
    expect(flowHealthLabel({ flowsLive: 15, flowsTotal: 16, redials: 1 })).toBe('15/16 flows • 1 re-dial');
  });

  test('omits the re-dial clause when redials is 0 or absent', () => {
    expect(flowHealthLabel({ flowsLive: 16, flowsTotal: 16, redials: 0 })).toBe('16/16 flows');
    expect(flowHealthLabel({ flowsLive: 16, flowsTotal: 16 })).toBe('16/16 flows');
  });

  test('shows nothing for a single-flow transfer (flowsTotal <= 1)', () => {
    expect(flowHealthLabel({ flowsLive: 1, flowsTotal: 1, redials: 0 })).toBe('');
  });

  test('shows nothing when the fields are entirely absent (single-flow/legacy sender)', () => {
    expect(flowHealthLabel({})).toBe('');
    expect(flowHealthLabel(undefined)).toBe('');
  });

  test('falls back flowsLive to flowsTotal when flowsLive is missing but flowsTotal is multi', () => {
    expect(flowHealthLabel({ flowsTotal: 8 })).toBe('8/8 flows');
  });
});

describe('upsertFailedFile — dedupe-by-fileId accumulator', () => {
  test('adds a new entry to an empty/absent list', () => {
    expect(upsertFailedFile(undefined, { fileId: 3, reason: 'io_error' })).toEqual([{ fileId: 3, reason: 'io_error' }]);
    expect(upsertFailedFile([], { fileId: 3, reason: 'io_error' })).toEqual([{ fileId: 3, reason: 'io_error' }]);
  });

  test('appends a second, distinct fileId', () => {
    const first = upsertFailedFile([], { fileId: 1, reason: 'io_error' });
    const second = upsertFailedFile(first, { fileId: 2, reason: 'io_error' });
    expect(second).toEqual([{ fileId: 1, reason: 'io_error' }, { fileId: 2, reason: 'io_error' }]);
  });

  test('a repeat fileId REPLACES the prior entry rather than duplicating it', () => {
    const first = upsertFailedFile([], { fileId: 1, reason: 'io_error' });
    const second = upsertFailedFile(first, { fileId: 1, reason: 'io_error' }); // a retry that failed again
    expect(second).toHaveLength(1);
    expect(second).toEqual([{ fileId: 1, reason: 'io_error' }]);
  });

  test('is pure — does not mutate the input array', () => {
    const first = Object.freeze(upsertFailedFile([], { fileId: 1, reason: 'io_error' }));
    expect(() => upsertFailedFile(first, { fileId: 2, reason: 'io_error' })).not.toThrow();
    expect(first).toHaveLength(1); // the frozen original is untouched
  });
});

describe('fileNameFor', () => {
  const manifest = { entries: [{ fileId: 0, path: 'top/sub/photo.jpg', size: 10 }, { fileId: 1, path: 'readme.txt', size: 5 }] };

  test('resolves a nested path to its basename', () => {
    expect(fileNameFor(manifest, 0)).toBe('photo.jpg');
  });

  test('resolves a flat file to its own name', () => {
    expect(fileNameFor(manifest, 1)).toBe('readme.txt');
  });

  test('falls back to the raw fileId when the manifest lacks that entry', () => {
    expect(fileNameFor(manifest, 99)).toBe('99');
    expect(fileNameFor(null, 5)).toBe('5');
    expect(fileNameFor({}, 5)).toBe('5');
  });
});

describe('isFinishingTail', () => {
  test('true for the sender "finishing" and receiver "verifying" states', () => {
    expect(isFinishingTail('finishing')).toBe(true);
    expect(isFinishingTail('verifying')).toBe(true);
  });

  test('false for every other state', () => {
    for (const s of ['active', 'awaiting-approval', 'interrupted', 'reconnecting', 'done', 'declined', 'canceled', 'error', undefined]) {
      expect(isFinishingTail(s)).toBe(false);
    }
  });
});

describe('aggregateDetail — bytes/rate/ETA/files, with the verify-tail fix', () => {
  test('an active transfer shows bytes, a live rate, and an ETA', () => {
    const d = aggregateDetail({
      progress: { received: 50, total: 100, filesDone: 1, filesTotal: 4 },
      rate: 10, // 10 B/s
      state: 'active',
    });
    expect(d.bytesText).toBe('50 B of 100 B');
    expect(d.rateText).toBe('10 B/s');
    expect(d.etaText).toBe('~5s left');
    expect(d.filesText).toBe('1 / 4 files');
  });

  test('the deferred known-minor, fixed: the verify tail (fraction→1, no more byte movement) shows' +
    ' "Finishing…" and NO rate, never a frozen speed or a bogus "~0s left"', () => {
    // All bytes already in (remaining = 0) and a stale rate left over from the last
    // sample before the tail began — the exact shape that used to render "0 MB/s" /
    // "~0s left" once the state flipped to finishing/verifying.
    const d = aggregateDetail({
      progress: { received: 100, total: 100, filesDone: 4, filesTotal: 4 },
      rate: 12_000_000, // stale — no bytes have moved since this was sampled
      state: 'finishing',
    });
    expect(d.etaText).toBe('Finishing…');
    expect(d.rateText).toBe('');
    expect(d.etaText).not.toMatch(/0s/);

    const v = aggregateDetail({
      progress: { received: 100, total: 100, filesDone: 3, filesTotal: 4 },
      rate: 5_000_000,
      state: 'verifying',
    });
    expect(v.etaText).toBe('Finishing…');
    expect(v.rateText).toBe('');
  });

  test('no rate yet (rate null/0) shows blank rate/ETA rather than a fabricated one', () => {
    const d = aggregateDetail({ progress: { received: 0, total: 100 }, rate: null, state: 'active' });
    expect(d.rateText).toBe('');
    expect(d.etaText).toBe('');
  });

  test('filesText is omitted when filesTotal is unknown/absent', () => {
    const d = aggregateDetail({ progress: { received: 10, total: 100 }, rate: 5, state: 'active' });
    expect(d.filesText).toBe('');
  });
});
