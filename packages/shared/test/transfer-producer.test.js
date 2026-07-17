import { describe, it, expect } from 'vitest';
import { createChunkProducer } from '../src/transfer-producer.js';
import { createRangeSet } from '../src/transfer-ranges.js';

function slicerOver(bytes) {
  return (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length));
}

describe('transfer-producer', () => {
  it('yields all chunks and hashes every byte when nothing is covered', async () => {
    const bytes = new Uint8Array(25).map((_, i) => i);
    const hashed = [];
    const p = createChunkProducer({ readChunk: slicerOver(bytes), hashUpdate: (b) => hashed.push(...b), chunkSize: 10 });
    const out = [];
    for await (const c of p.produce({ fileId: 0, size: 25 }, createRangeSet())) out.push({ offset: c.offset, length: c.length });
    expect(out).toEqual([{ offset: 0, length: 10 }, { offset: 10, length: 10 }, { offset: 20, length: 5 }]);
    expect(hashed.length).toBe(25); // every byte hashed
  });

  it('skips covered chunks for sending but still hashes them (resume correctness)', async () => {
    const bytes = new Uint8Array(30).fill(7);
    const hashed = [];
    const p = createChunkProducer({ readChunk: slicerOver(bytes), hashUpdate: (b) => hashed.push(...b), chunkSize: 10 });
    const covered = createRangeSet([[0, 10]]); // first chunk already on the far end
    const out = [];
    for await (const c of p.produce({ fileId: 0, size: 30 }, covered)) out.push(c.offset);
    expect(out).toEqual([10, 20]);        // only the uncovered chunks are sent
    expect(hashed.length).toBe(30);       // but the whole file was hashed
  });
});
