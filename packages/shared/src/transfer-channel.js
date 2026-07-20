// packages/shared/src/transfer-channel.js
// SP3 (design §3, §8.4): adapts injected IPC primitives into the sender/receiver
// channel contract `{ sendCtrl, sendBulk, onCtrl, onBulk }`. MAIN-ONLY in
// production (transfer-sender.js/transfer-receiver.js live in main), but kept pure and
// runtime-agnostic like the rest of shared/ — no Electron import here. `send`
// and `on` are injected: production wires them to ipcMain/webContents.send for
// a specific worker window (see controller/src/transfer-worker.js); tests
// inject fakes.
//
// Backpressure (design §7, IPC stage): `sendBulk` sends the chunk immediately,
// then returns a Promise that resolves once the worker signals capacity via an
// 'ft-bulk-credit' event on the injected `on`. This lets main throttle its
// disk-read loop to the channel's real drain rate instead of buffering
// unboundedly in the IPC layer. If no `on` is injected at all, there is no
// credit source to wait on, so sendBulk resolves immediately (used by callers
// that don't need backpressure, e.g. simple tests).
//
// Flow-death handling (multi-flow send pool, C1): the REAL worker only emits
// 'ft-bulk-credit' when its data channel is open — if the flow dies mid-send
// (connection failed/closed) the worker silently drops the chunk and never
// credits, so a pending sendBulk would hang FOREVER with nothing to resolve or
// reject it. `fail(reason)` is the escape hatch: the assembly layer
// (transfer-channel-assembly.js) calls it when a worker reports a terminal
// connection state, which REJECTS every pending sendBulk so the caller (the
// dynamic send pool) can retire this flow and requeue the chunk onto a
// survivor instead of deadlocking `pool.run()` forever.
export function createTransferChannel({ send, on }) {
  let creditWaiters = []; // { resolve, reject } pairs — one per pending sendBulk
  let creditListenerRegistered = false;
  let dead = false;

  function ensureCreditListener() {
    if (creditListenerRegistered || typeof on !== 'function') return;
    creditListenerRegistered = true;
    on('ft-bulk-credit', () => {
      // One credit event releases exactly one pending sendBulk waiter — mirrors
      // one 'bufferedamountlow' firing granting one more chunk's worth of room.
      const waiter = creditWaiters.shift();
      if (waiter) waiter.resolve();
    });
  }

  return {
    sendCtrl(str) {
      send('ft-ctrl', str);
    },
    sendBulk(buf) {
      // Dead flow: reject immediately, never send/queue — the pool must be
      // able to retire this flow and requeue the chunk without waiting on
      // anything that will never arrive.
      if (dead) return Promise.reject(new Error('flow_dead'));
      send('ft-bulk', buf);
      if (typeof on !== 'function') return Promise.resolve();
      ensureCreditListener();
      return new Promise((resolve, reject) => { creditWaiters.push({ resolve, reject }); });
    },
    onCtrl(cb) {
      if (typeof on === 'function') on('ft-ctrl-in', cb);
    },
    onBulk(cb) {
      if (typeof on === 'function') on('ft-bulk-in', cb);
    },
    // Marks this channel's flow as dead: rejects every currently-pending
    // sendBulk (so a hung wait resolves NOW, as a rejection) and makes every
    // future sendBulk reject immediately without sending. Idempotent.
    fail(reason) {
      if (dead) return;
      dead = true;
      const waiters = creditWaiters;
      creditWaiters = [];
      const err = new Error(reason || 'flow_dead');
      waiters.forEach((w) => w.reject(err));
    },
  };
}
