// packages/host/src/transfer-worker/signaling-client.js
// Dedicated ONE-SHOT signaling client for the transfer worker — deliberately
// NOT the app's main signaling-client.js. The transfer rendezvous is a single
// request/response exchange (CONNECT{kind:transfer} or ATTACH → ICE_SERVERS →
// OFFER/ANSWER/CANDIDATE) over a throwaway socket; it must NOT auto-register as
// a host and must expose a `ready` promise that worker.js awaits before sending
// its first frame. (The host's main signaling-client.js is an auto-registering,
// auto-reconnecting client — using it here registered the transfer worker as a
// bogus host AND dropped the ATTACH, since it has no `ready` and gates send on an
// already-open socket. That broke every receive.) Kept byte-identical to the
// controller's copy so both apps' transfer worker.js behave the same.
import { buildMessage, parseMessage } from '@farsight/shared/protocol';
import { assertSecureSignalingUrl } from '@farsight/shared/signaling-url';

export function createSignalingClient(url, handlers) {
  assertSecureSignalingUrl(url); // R-3: refuse plaintext ws:// off-localhost
  const ws = new WebSocket(url);
  const ready = new Promise((res) => ws.addEventListener('open', () => res()));
  ws.addEventListener('message', (ev) => {
    let msg; try { msg = parseMessage(ev.data); } catch { return; }
    const fn = handlers[msg.type]; if (fn) fn(msg);
  });
  return {
    ready,
    send: (type, payload) => ws.send(JSON.stringify(buildMessage(type, payload))),
    close: () => ws.close(),
  };
}
