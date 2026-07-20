import { describe, it, expect } from 'vitest';
import { createChunkProducer } from '../src/transfer-producer.js';
import { createRangeSet } from '../src/transfer-ranges.js';
import { TRANSFER_CHUNK_BYTES } from '../src/transfer-chunk.js';

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

  it('defaults chunkSize to the shared TRANSFER_CHUNK_BYTES grid constant, and hashUpdate is optional', async () => {
    expect(TRANSFER_CHUNK_BYTES).toBe(131072);
    const size = TRANSFER_CHUNK_BYTES + 1; // exactly 2 grid chunks
    const src = new Uint8Array(size);
    const chunks = [];
    const p = createChunkProducer({ readChunk: slicerOver(src) }); // no chunkSize, no hashUpdate
    for await (const c of p.produce({ fileId: 0, size }, createRangeSet())) chunks.push(c.length);
    expect(chunks).toEqual([TRANSFER_CHUNK_BYTES, 1]);
  });

  it('throws immediately for a non-positive chunkSize instead of infinite-looping', () => {
    expect(() => createChunkProducer({ readChunk: () => Promise.resolve(new Uint8Array()), hashUpdate: () => {}, chunkSize: 0 }))
      .toThrow('chunkSize must be > 0');
    expect(() => createChunkProducer({ readChunk: () => Promise.resolve(new Uint8Array()), hashUpdate: () => {}, chunkSize: -1 }))
      .toThrow('chunkSize must be > 0');
  });
});
