// packages/shared/src/transfer-send-pool.js
// Pure dynamic dispatcher: pulls self-addressed chunks from an async iterable and
// keeps every live flow busy — each chunk goes to whichever live flow is currently
// IDLE (not mid-send), so fast flows take more and slow flows take fewer. A flow
// that dies (isAlive() false) or whose sendBulk rejects hands its chunk back for a
// surviving flow, and a rejecting flow is retired so it can't spin. Backpressure is
// each flow's own sendBulk() promise (resolves on per-flow credit). Throws
// no_live_flows if a chunk remains and no flow is usable — unless an `awaitFlow`
// callback is supplied, in which case starvation awaits it (retrying dispatch on
// resolve, so a flow supervisor can resupply `flows` mid-run) and only throws if
// awaitFlow itself rejects. No fs/DOM/WebRTC.
import { encodeBulkFrame } from './transfer-chunk.js';

// `limiter` (optional, Plan 3 Task 6): a shared { take(n) } rate limiter, paced
// at the ONE choke point below (all N flows share it, so the aggregate byte
// rate is what's bounded, not each flow individually). Absent -> byte-for-byte
// unchanged dispatch (guarded, never called).
export function createSendPool({ flows, encodeFrame = encodeBulkFrame, awaitFlow, limiter }) {
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
        // Promise.resolve().then(...) so a SYNCHRONOUS throw from sendBulk (or from
        // encodeFrame) becomes a rejection (handled), never an escaped throw. The
        // optional global limiter (Plan 3 Task 6) is paced HERE, on the encoded
        // frame's byte length, right before the actual sendBulk -- the one choke
        // point every flow's dispatch passes through, so a single shared limiter
        // instance paces the whole pool's aggregate output.
        const p = Promise.resolve()
          .then(() => encodeFrame(chunk))
          .then(async (frame) => {
            // encodeFrame's default (encodeBulkFrame) returns an ArrayBuffer
            // (byteLength, not length); fall back to `.length` for a fake/
            // alternate encodeFrame that returns a Buffer/typed array instead.
            if (limiter) await limiter.take(frame.byteLength ?? frame.length);
            return flow.sendBulk(frame);
          })
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
          if (inflight.size === 0) {
            if (!awaitFlow) throw new Error('no_live_flows'); // nothing usable at all, no resupply option
            requeue.unshift(chunk);                // hold it; wait for a resupplied flow
            try { await awaitFlow(); } catch { throw new Error('no_live_flows'); }
            continue;                              // retry dispatch — a new flow may be in `flows` now
          }
          requeue.unshift(chunk);                  // hold it; wait for a flow to free
          await Promise.race(inflight.values());
        }
      }
    },
  };
}
