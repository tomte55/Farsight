// packages/signaling-server/src/client-ip.js
// H-1: behind a reverse proxy (Caddy+Docker), req.socket.remoteAddress is a
// constant proxy IP, so per-IP limits collapse onto a single key. Only trust
// X-Forwarded-For when the deployer has explicitly opted in (trustProxy) —
// otherwise any direct client could spoof it to evade or frame other IPs.
//
// We trust exactly ONE proxy hop (Caddy's single `reverse_proxy`), which
// APPENDS the immediate peer's address to X-Forwarded-For and does not strip
// a client-supplied header. That means the LEFT-most entry is fully
// client-controlled (a client can send `X-Forwarded-For: 9.9.9.9` and Caddy
// forwards `9.9.9.9, <real-peer>`) and must never be trusted. The RIGHT-most
// entry is the one Caddy itself appended, i.e. the real immediate client. If
// more than one proxy is ever chained in front of this server, this needs to
// generalize to right-most-minus-(trusted-hops-1).
export function clientIp({ remoteAddress, forwardedFor, trustProxy } = {}) {
  if (trustProxy && typeof forwardedFor === 'string' && forwardedFor.trim() !== '') {
    const parts = forwardedFor.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1]; // right-most = appended by the trusted proxy = real peer
  }
  return remoteAddress;
}
