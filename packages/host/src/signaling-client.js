// packages/host/src/signaling-client.js
import { MSG, buildMessage, parseMessage } from '@farsight/shared/protocol';
import { assertSecureSignalingUrl } from '@farsight/shared/signaling-url';

// Host signaling client with **auto-reconnect + re-register**. A host must hold a
// live registration to stay connectable from the console; a dropped socket (server
// restart, network blip, laptop sleep) must self-heal, otherwise the host keeps
// heartbeating presence (looks Online) while being unreachable → CONNECT returns
// host_offline. On every (re)connect it re-sends REGISTER; the caller's REGISTERED
// handler then re-syncs the current password (UPDATE_PASSWORD) and reports the
// fresh signaling id. WebSocket + timers are injectable for tests.
function noopLog() { const n = { debug() {}, info() {}, warn() {}, error() {}, child: () => n }; return n; }

export function createSignalingClient(
  url,
  handlers,
  { password, version, acceptsLinked, WebSocketImpl, setTimeout: setT, clearTimeout: clearT, log = noopLog() } = {},
) {
  assertSecureSignalingUrl(url); // R-3: refuse plaintext ws:// off-localhost
  const WS = WebSocketImpl ?? WebSocket;
  const schedule = setT ?? setTimeout;
  const cancel = clearT ?? clearTimeout;

  let ws = null;
  let closed = false;      // intentional close() — stop reconnecting
  let attempt = 0;         // backoff counter, reset on a successful open
  let reconnectTimer = null;

  const connect = () => {
    log.debug('connecting');
    ws = new WS(url);
    ws.addEventListener('open', () => {
      attempt = 0;
      // SP1 version + SP2 acceptsLinked (opt into password-free linked connect)
      // ride REGISTER. The server assigns a fresh id → REGISTERED.
      ws.send(JSON.stringify(buildMessage(MSG.REGISTER, { password, version, acceptsLinked })));
      log.info('socket open — register sent');
    });
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = parseMessage(ev.data); } catch { return; }
      const fn = handlers[msg.type]; if (fn) fn(msg);
    });
    ws.addEventListener('close', () => {
      if (closed) return;
      // Capped exponential backoff: 1s, 2s, 4s, 8s, 15s (max).
      const delay = Math.min(1000 * 2 ** attempt, 15000);
      attempt += 1;
      log.warn(`socket closed — reconnect attempt ${attempt} in ${delay}ms`);
      reconnectTimer = schedule(connect, delay);
    });
    ws.addEventListener('error', () => { log.warn('socket error'); try { ws.close(); } catch { /* close triggers reconnect */ } });
  };
  connect();

  return {
    send: (type, payload) => { if (ws && ws.readyState === WS.OPEN) ws.send(JSON.stringify(buildMessage(type, payload))); },
    close: () => {
      closed = true;
      if (reconnectTimer) { cancel(reconnectTimer); reconnectTimer = null; }
      if (ws) ws.close();
    },
  };
}
