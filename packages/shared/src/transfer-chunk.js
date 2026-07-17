// Pure binary framing for 'ft-bulk' chunks in the multi-flow transfer. Each bulk
// frame is self-addressing so a chunk can arrive on any flow, in any order, and
// still be written to the right place: [u32 fileId][u64 offset][u32 length][payload].
// NO fs/WebRTC/DOM. decode returns null on any malformed/hostile input.
export const BULK_HEADER_BYTES = 16;

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
