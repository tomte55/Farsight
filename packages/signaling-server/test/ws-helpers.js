// packages/signaling-server/test/ws-helpers.js
import { WebSocket } from 'ws';

export const open = (url) => new Promise((res) => { const w = new WebSocket(url); w.on('open', () => res(w)); });

// Queue-based reader: attach the listener right after open so no message is
// dropped when several arrive back-to-back (e.g. ICE_SERVERS then CONNECT).
// read() resolves the next queued message in order.
export function reader(w) {
  const q = []; const waiters = [];
  w.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    if (waiters.length) waiters.shift()(msg); else q.push(msg);
  });
  return () => new Promise((res) => { if (q.length) res(q.shift()); else waiters.push(res); });
}
