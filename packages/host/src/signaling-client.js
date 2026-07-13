// packages/host/src/signaling-client.js
import { MSG, buildMessage, parseMessage } from '@farsight/shared/protocol';
import { assertSecureSignalingUrl } from '@farsight/shared/signaling-url';

export function createSignalingClient(url, handlers, { password } = {}) {
  assertSecureSignalingUrl(url); // R-3: refuse plaintext ws:// off-localhost
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => ws.send(JSON.stringify(buildMessage(MSG.REGISTER, { password }))));
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
