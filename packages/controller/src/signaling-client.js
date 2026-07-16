// packages/controller/src/signaling-client.js
import { buildMessage, parseMessage } from '@farsight/shared/protocol';
import { assertSecureSignalingUrl } from '@farsight/shared/signaling-url';

function noopLog() { const n = { debug() {}, info() {}, warn() {}, error() {}, child: () => n }; return n; }

export function createSignalingClient(url, handlers, { log = noopLog() } = {}) {
  assertSecureSignalingUrl(url); // R-3: refuse plaintext ws:// off-localhost
  log.debug('connecting');
  let closed = false; // intentional close() — a normal teardown, not a failure
  const ws = new WebSocket(url);
  const ready = new Promise((res) => ws.addEventListener('open', () => res()));
  ws.addEventListener('open', () => log.info('socket open'));
  ws.addEventListener('message', (ev) => {
    let msg; try { msg = parseMessage(ev.data); } catch { return; }
    const fn = handlers[msg.type]; if (fn) fn(msg);
  });
  // Normal session teardown (disconnect button, host-ended) calls close() → info.
  // A socket that drops on its own is a real problem → warn.
  ws.addEventListener('close', () => { if (closed) log.info('socket closed'); else log.warn('socket closed unexpectedly'); });
  ws.addEventListener('error', () => log.warn('socket error'));
  return {
    ready,
    send: (type, payload) => ws.send(JSON.stringify(buildMessage(type, payload))),
    close: () => { closed = true; ws.close(); },
  };
}
