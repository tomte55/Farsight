// packages/controller/src/signaling-client.js
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
