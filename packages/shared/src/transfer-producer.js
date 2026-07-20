// Pure: reads a file sequentially once, feeding a hash sink for EVERY byte (so the
// full-file hash is correct even when resuming) while yielding only the chunks whose
// byte range is not already covered on the far end. The single sequential read keeps
// sender disk I/O efficient; the gap filter avoids resending resumed bytes.
import { TRANSFER_CHUNK_BYTES } from './transfer-chunk.js';
export function createChunkProducer({ readChunk, hashUpdate = () => {}, chunkSize = TRANSFER_CHUNK_BYTES }) {
  if (!(chunkSize > 0)) throw new Error('chunkSize must be > 0');
  return {
    async *produce(file, coveredRangeSet) {
      const { fileId, size } = file;
      let offset = 0;
      while (offset < size) {
        const length = Math.min(chunkSize, size - offset);
        const payload = await readChunk(offset, length);
        hashUpdate(payload);
        if (!coveredRangeSet.covers(offset, length)) {
          yield { fileId, offset, length, payload };
        }
        offset += length;
      }
    },
  };
}
