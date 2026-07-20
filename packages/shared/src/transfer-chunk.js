// Pure binary framing for 'ft-bulk' chunks in the multi-flow transfer. Each bulk
// frame is self-addressing so a chunk can arrive on any flow, in any order, and
// still be written to the right place: [u32 fileId][u64 offset][u32 length][payload].
// NO fs/WebRTC/DOM. decode returns null on any malformed/hostile input.
//
// DELIVERY IS AT-LEAST-ONCE, NOT exactly-once — duplicates are EXPECTED. The send
// pool transmits a chunk over a flow BEFORE awaiting that flow's credit
// (transfer-channel.js sendBulk() sends, then returns the credit promise); if the
// flow then dies, the pool requeues the chunk onto a surviving flow
// (transfer-send-pool.js) even though the original copy may already have reached
// the receiver. Because every frame carries its own fileId+offset, a re-delivered
// chunk just overwrites the same bytes at the same offset — a harmless no-op.
// This idempotency is LOAD-BEARING and must be preserved by anything downstream:
// the positional sparse writer (transfer-io.js writeAt) and the received-range set
// (transfer-ranges.js add(), which coalesces so covered-bytes can't double-count).
// Any future per-chunk accounting or incremental/streaming hash MUST NOT assume a
// chunk arrives exactly once — e.g. never `received += length` per bulk frame
// without range dedup, and never fold bytes into a running hash as they arrive on
// an unordered, possibly-duplicating flow.
export const BULK_HEADER_BYTES = 16;

// The transfer chunk grid unit: one bulk frame payload == one coverage interval
// == one per-chunk-hash unit (Phase 4). Sender/receiver/producer/router all key
// off this single constant so the send grid and the hash grid can never drift.
export const TRANSFER_CHUNK_BYTES = 131072;

export function encodeBulkFrame({ fileId, offset, length, payload }) {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (bytes.byteLength !== length) throw new Error('length must equal payload.byteLength');
  if (!Number.isInteger(fileId) || fileId < 0 || fileId > 0xffffffff) throw new Error('bad fileId');
  if (!Number.isInteger(offset) || offset < 0) throw new Error('bad offset');
  const out = new Uint8Array(BULK_HEADER_BYTES + length);
  const view = new DataView(out.buffer);
  view.setUint32(0, fileId, false);
  view.setBigUint64(4, BigInt(offset), false);
  view.setUint32(12, length, false);
  out.set(bytes, BULK_HEADER_BYTES);
  return out.buffer;
}

export function decodeBulkFrame(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < BULK_HEADER_BYTES) return null;
  const view = new DataView(buf);
  const fileId = view.getUint32(0, false);
  const offsetBig = view.getBigUint64(4, false);
  const length = view.getUint32(12, false);
  if (offsetBig > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  if (BULK_HEADER_BYTES + length !== buf.byteLength) return null;
  const payload = new Uint8Array(buf, BULK_HEADER_BYTES, length);
  return { fileId, offset: Number(offsetBig), length, payload };
}
