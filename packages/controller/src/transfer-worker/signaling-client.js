// packages/controller/src/transfer-worker/signaling-client.js
// Dedicated ONE-SHOT signaling client for the transfer worker — deliberately
// NOT the app's main signaling-client.js. The transfer rendezvous is a single
// request/response exchange (CONNECT{kind:transfer} or ATTACH → ICE_SERVERS →
// OFFER/ANSWER/CANDIDATE) over a throwaway socket; it must NOT auto-register as
// a host and must expose a `ready` promise that worker.js awaits before sending
// its first frame. (The host's main signaling-client.js is an auto-registering,
// auto-reconnecting client — using it here would register the transfer worker as
// a bogus host AND drop the first send, since it has no `ready` and gates send on
// an already-open socket. That broke every receive.) Kept byte-identical to the
// host's copy so both apps' transfer worker.js behave the same.
//
// F-B1 (Plan 1b Task 5): the socket must REPORT its own failure, never hang. It
// registers error+close handlers and a bounded connect timeout; `ready` REJECTS
// on error / close-before-open / timeout (so `await signal.ready` can't wedge the
// worker's rendezvous and stick the supervisor slot `dialing`), and a drop AFTER
// open invokes `onClose` so worker.js can surface a terminal session-state and the
// supervisor re-dials the slot (the transfer worker needs signaling for ICE
// restart, so a lost socket means the flow can no longer recover on its own).
import { buildMessage, parseMessage } from '@farsight/shared/protocol';
import { assertSecureSignalingUrl } from '@farsight/shared/signaling-url';

export function createSignalingClient(url, handlers, opts = {}) {
  assertSecureSignalingUrl(url); // R-3: refuse plaintext ws:// off-localhost
  const {
    WebSocketImpl = WebSocket,
    setTimeout: setTimer = setTimeout,
    clearTimeout: clearTimer = clearTimeout,
    connectTimeoutMs = 15000,
    onClose = null, // invoked on a drop AFTER open (not on an intentional close())
  } = opts;

  const ws = new WebSocketImpl(url);
  let opened = false;     // the socket reached 'open' at least once
  let intentional = false; // our own close() was called — suppress onClose/reject
  let settled = false;    // ready has resolved OR rejected (guard double-settle)
  let timer = null;

  const ready = new Promise((resolve, reject) => {
    const finishOk = () => { if (settled) return; settled = true; if (timer != null) clearTimer(timer); resolve(); };
    const finishErr = (reason) => { if (settled) return; settled = true; if (timer != null) clearTimer(timer); reject(new Error(reason)); };

    ws.addEventListener('open', () => { opened = true; finishOk(); });
    ws.addEventListener('error', () => {
      // Before open: a connect failure → reject. After open: a live-socket error
      // usually precedes a 'close', which surfaces the terminal state below;
      // don't reject an already-resolved ready.
      if (!opened && !intentional) finishErr('signaling_error');
    });
    ws.addEventListener('close', () => {
      if (timer != null) clearTimer(timer);
      if (intentional) return;                       // teardown — expected, silent
      if (!opened) { finishErr('signaling_closed'); return; } // never opened → reject ready
      if (typeof onClose === 'function') onClose();  // dropped mid-transfer → terminal
    });
    // Bounded connect timeout: a socket that never opens (nor errors/closes)
    // must not hang ready forever.
    timer = setTimer(() => finishErr('signaling_timeout'), connectTimeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  // A caller might attach its await/.catch a tick late (worker.js runs sync code
  // between createSignalingClient and `await signal.ready`); swallow here so a
  // pre-await rejection doesn't surface as an unhandledrejection. The caller still
  // sees the rejection on its own await of the SAME promise.
  ready.catch(() => {});

  ws.addEventListener('message', (ev) => {
    let msg; try { msg = parseMessage(ev.data); } catch { return; }
    const fn = handlers[msg.type]; if (fn) fn(msg);
  });
  return {
    ready,
    send: (type, payload) => ws.send(JSON.stringify(buildMessage(type, payload))),
    close: () => { intentional = true; if (timer != null) clearTimer(timer); ws.close(); },
    // Plan-1b Task 4/5 fault injection ONLY (dropFlowSocket): close the raw socket
    // WITHOUT marking it intentional, so the close/error handlers surface it as an
    // UNEXPECTED drop (reject ready pre-open, onClose post-open) — exactly what a
    // real network/server drop does. Never called in production (the worker's fault
    // listener is wired only under --ft-test-hooks=1).
    dropForTest: () => { try { ws.close(); } catch { /* guarded */ } },
  };
}
