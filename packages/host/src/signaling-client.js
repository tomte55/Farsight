// packages/host/src/signaling-client.js
import { MSG, buildMessage, parseMessage } from '@farsight/shared/protocol';
import { assertSecureSignalingUrl } from '@farsight/shared/signaling-url';

export function createSignalingClient(url, handlers, { password, version, acceptsLinked } = {}) {
  assertSecureSignalingUrl(url); // R-3: refuse plaintext ws:// off-localhost
  const ws = new WebSocket(url);
  // SP1: announce our app version on REGISTER so the server can relay it to a
  // connecting controller (and later surface it to the console).
  // Connect-from-console (SP2 §4.4): acceptsLinked opts this host into
  // password-free "linked" connects from the owner's own account devices — the
  // real auth is the E2E keypair handshake, so this only relaxes the signaling
  // password gate.
  ws.addEventListener('open', () => ws.send(JSON.stringify(buildMessage(MSG.REGISTER, { password, version, acceptsLinked }))));
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = parseMessage(ev.data); } catch { return; }
    const fn = handlers[msg.type];
    if (fn) fn(msg);
  });
  return {
    send: (type, payload) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(buildMessage(type, payload))); },
    close: () => ws.close(),
  };
}
