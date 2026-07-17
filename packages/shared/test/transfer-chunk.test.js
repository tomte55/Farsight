import { describe, it, expect } from 'vitest';
import { encodeBulkFrame, decodeBulkFrame, BULK_HEADER_BYTES } from '../src/transfer-chunk.js';

describe('transfer-chunk', () => {
  it('round-trips fileId/offset/length/payload', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const buf = encodeBulkFrame({ fileId: 7, offset: 128, length: 5, payload });
    expect(buf.byteLength).toBe(BULK_HEADER_BYTES + 5);
    const d = decodeBulkFrame(buf);
    expect(d).toEqual({ fileId: 7, offset: 128, length: 5, payload });
  });

  it('handles a 64-bit offset beyond 2^32 (large file)', () => {
    const offset = 90_000_000_000; // 90 GB, > 2^32
    const payload = new Uint8Array([9]);
    const d = decodeBulkFrame(encodeBulkFrame({ fileId: 0, offset, length: 1, payload }));
    expect(d.offset).toBe(offset);
    expect(d.fileId).toBe(0);
  });

  it('returns null on a truncated buffer', () => {
    expect(decodeBulkFrame(new ArrayBuffer(8))).toBe(null);
  });

  it('returns null when declared length exceeds available payload bytes', () => {
    const good = encodeBulkFrame({ fileId: 1, offset: 0, length: 3, payload: new Uint8Array([1, 2, 3]) });
    // Corrupt the declared length to 99 while payload is only 3 bytes.
    const view = new DataView(good);
    view.setUint32(12, 99, false);
    expect(decodeBulkFrame(good)).toBe(null);
  });

  it('throws if length !== payload.byteLength on encode', () => {
    expect(() => encodeBulkFrame({ fileId: 1, offset: 0, length: 4, payload: new Uint8Array([1, 2, 3]) }))
      .toThrow();
  });
});
