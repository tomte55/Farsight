// Pure dynamic dispatcher: pulls self-addressed chunks from an async iterable and
// hands each to whichever flow is free and alive. Fast flows naturally pull more;
// a dead/rejecting flow's chunk is requeued onto a live flow. Backpressure is the
// flow's own sendBulk() promise (resolves on per-flow credit). No fs/DOM/WebRTC.
import { encodeBulkFrame } from './transfer-chunk.js';

export function createSendPool({ flows, encodeFrame = encodeBulkFrame }) {
  function liveFlows() { return flows.filter((f) => f.isAlive()); }

  async function sendOne(chunk) {
    // Try live flows until one accepts the chunk. Requeue on rejection/death.
    for (;;) {
      const live = liveFlows();
      if (live.length === 0) throw new Error('no_live_flows');
      const flow = live[0];
      try {
        await flow.sendBulk(encodeFrame(chunk));
        return;
      } catch {
        // this flow failed; loop picks another live flow (or throws no_live_flows)
      }
    }
  }

  return {
    aliveCount: () => liveFlows().length,
    async run(chunkIterable) {
      // One worker per flow slot; each worker pulls the next chunk and sends it,
      // so concurrency == live flow count and fast flows drain the iterable faster.
      const it = chunkIterable[Symbol.asyncIterator]();
      let done = false;
      async function worker() {
        for (;;) {
          if (done) return;
          const { value, done: d } = await it.next();
          if (d) { done = true; return; }
          await sendOne(value);
        }
      }
      const workerCount = Math.max(1, flows.length);
      await Promise.all([...Array(workerCount)].map(() => worker()));
    },
  };
}
