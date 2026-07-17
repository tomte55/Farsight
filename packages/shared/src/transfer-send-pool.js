// packages/shared/src/transfer-send-pool.js
// Pure dynamic dispatcher: pulls self-addressed chunks from an async iterable and
// keeps every live flow busy — each chunk goes to whichever live flow is currently
// IDLE (not mid-send), so fast flows take more and slow flows take fewer. A flow
// that dies (isAlive() false) or whose sendBulk rejects hands its chunk back for a
// surviving flow, and a rejecting flow is retired so it can't spin. Backpressure is
// each flow's own sendBulk() promise (resolves on per-flow credit). Throws
// no_live_flows if a chunk remains and no flow is usable. No fs/DOM/WebRTC.
import { encodeBulkFrame } from './transfer-chunk.js';

export function createSendPool({ flows, encodeFrame = encodeBulkFrame }) {
  const failed = new Set(); // flows whose sendBulk rejected — retired as unusable
  function usableFlows() { return flows.filter((f) => f.isAlive() && !failed.has(f)); }

  return {
    aliveCount: () => usableFlows().length,
    async run(chunkIterable) {
      const it = chunkIterable[Symbol.asyncIterator]();
      const inflight = new Map(); // flow -> Promise settling when its current send completes
      const requeue = [];         // chunks handed back by a died/rejecting flow
      let sourceDone = false;

      // Dispatch chunk on an idle usable flow. Returns true if dispatched.
      function tryDispatch(chunk) {
        const flow = usableFlows().find((f) => !inflight.has(f));
        if (!flow) return false;
        // Promise.resolve().then(...) so a SYNCHRONOUS throw from sendBulk becomes a
        // rejection (handled), never an escaped throw.
        const p = Promise.resolve()
          .then(() => flow.sendBulk(encodeFrame(chunk)))
          .then(
            () => { inflight.delete(flow); },
            () => { inflight.delete(flow); failed.add(flow); requeue.push(chunk); },
          );
        inflight.set(flow, p);
        return true;
      }

      for (;;) {
        // Next chunk: retries first, then the source.
        let chunk = null;
        if (requeue.length) chunk = requeue.shift();
        else if (!sourceDone) {
          const { value, done } = await it.next();
          if (done) { sourceDone = true; continue; }
          chunk = value;
        }

        if (chunk === null) {
          if (inflight.size === 0) return;         // fully drained -> done
          await Promise.race(inflight.values());   // a flow will free up (maybe requeue)
          continue;
        }

        if (!tryDispatch(chunk)) {
          if (inflight.size === 0) throw new Error('no_live_flows'); // nothing usable at all
          requeue.unshift(chunk);                  // hold it; wait for a flow to free
          await Promise.race(inflight.values());
        }
      }
    },
  };
}
