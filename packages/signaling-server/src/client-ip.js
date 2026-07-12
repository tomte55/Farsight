// packages/signaling-server/src/client-ip.js
// H-1: behind a reverse proxy (Caddy+Docker), req.socket.remoteAddress is a
// constant proxy IP, so per-IP limits collapse onto a single key. Only trust
// X-Forwarded-For when the deployer has explicitly opted in (trustProxy) —
// otherwise any direct client could spoof it to evade or frame other IPs.
export function clientIp({ remoteAddress, forwardedFor, trustProxy } = {}) {
  if (trustProxy && typeof forwardedFor === 'string' && forwardedFor.trim() !== '') {
    return forwardedFor.split(',')[0].trim();
  }
  return remoteAddress;
}
