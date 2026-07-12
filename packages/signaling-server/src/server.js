// packages/signaling-server/src/server.js
import { WebSocketServer } from 'ws';
import { pathToFileURL } from 'node:url';
import { MSG, parseMessage, buildMessage } from '@farsight/shared/protocol';
import { generateHostId } from '@farsight/shared/host-id';
import { constantTimeEqual } from '@farsight/shared/password';
import { makeTurnCredential } from '@farsight/shared/turn';
import { createRegistry } from './registry.js';
import { createRateLimiter } from './rate-limit.js';
import { createConnectionLimits } from './limits.js';
import { createLogger } from './log.js';
import { loadConfig } from './config.js';

const IDLE_TIMEOUT_MS = 15000;

// Compute the ICE server list from config: STUN always, TURN (and optional TLS
// turns:) with ephemeral HMAC creds when a shared secret is configured. Both
// TURN urls share one credential via an RTCIceServer.urls array. Empty when no
// TURN is configured (LAN dev).
function iceServersFor(cfg) {
  if (!cfg.turnUri) return [];
  const stunUri = cfg.turnUri.replace('turn:', 'stun:');
  if (!cfg.turnSecret) return [{ urls: stunUri }];
  const { username, credential } = makeTurnCredential({ secret: cfg.turnSecret, ttlSeconds: cfg.turnTtlSeconds });
  const turnUrls = cfg.turnsUri ? [cfg.turnUri, cfg.turnsUri] : cfg.turnUri;
  return [
    { urls: stunUri },
    { urls: turnUrls, username, credential },
  ];
}

export function createSignalingServer({ port, config } = {}) {
  const cfg = config ?? loadConfig();
  const listenPort = port ?? cfg.port;
  // R-2: bound the payload so a single frame can't exhaust memory before parse.
  const wss = new WebSocketServer({ port: listenPort, maxPayload: 64 * 1024 });
  const registry = createRegistry();
  const limiter = createRateLimiter({ maxAttempts: cfg.maxAttempts, windowMs: cfg.windowMs });
  const limits = createConnectionLimits();
  const log = createLogger();

  const send = (socket, type, payload) => {
    if (socket && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(buildMessage(type, payload)));
    }
  };

  wss.on('connection', (socket, req) => {
    // R-4: capture the source IP at connection time so lockout can be keyed by
    // `targetId|sourceIp` (per attacker, not per host).
    const ip = req?.socket?.remoteAddress ?? 'unknown';

    // R-2: per-IP connection cap — reject floods before allocating state.
    if (!limits.canConnect(ip)) { socket.close(); return; }
    limits.addConn(ip);

    socket.farsight = { id: null, password: null, peerSocket: null, ip, registered: false };

    // R-2: close a socket that neither registers (host) nor pairs (controller)
    // within the idle window, so half-open sockets can't accumulate.
    let idleTimer = setTimeout(() => {
      if (!socket.farsight.id && !socket.farsight.peerSocket) socket.close();
    }, IDLE_TIMEOUT_MS);
    if (idleTimer.unref) idleTimer.unref();
    const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = parseMessage(raw.toString());
      } catch {
        return; // ignore malformed input
      }

      switch (msg.type) {
        case MSG.REGISTER: {
          if (socket.farsight.registered) break; // one registration per socket
          // R-2: per-IP registration cap.
          if (!limits.canRegister(socket.farsight.ip)) { send(socket, MSG.ERROR, { reason: 'rate_limited' }); break; }
          let id;
          do { id = generateHostId(); } while (registry.has(id));
          socket.farsight.id = id;
          socket.farsight.registered = true;
          limits.addReg(socket.farsight.ip);
          clearIdle();
          // Session password is generated client-side and held in memory only.
          socket.farsight.password = typeof msg.password === 'string' ? msg.password : null;
          registry.add(id, socket);
          send(socket, MSG.REGISTERED, { id });
          log.event('register', { id });
          break;
        }
        case MSG.CONNECT: {
          const target = registry.get(msg.targetId);
          if (!target) { send(socket, MSG.ERROR, { reason: 'host_offline' }); break; }
          // R-4: composite lockout key scopes attempts to (host, this controller IP).
          const key = `${msg.targetId}|${socket.farsight.ip}`;
          if (limiter.isLocked(key)) { log.event('locked', { id: msg.targetId }); send(socket, MSG.ERROR, { reason: 'locked' }); break; }
          if (!target.farsight.password || !constantTimeEqual(String(msg.password ?? ''), target.farsight.password)) {
            limiter.recordFailure(key);
            log.event('auth_fail', { id: msg.targetId, reason: 'bad_password' });
            send(socket, MSG.ERROR, { reason: 'bad_password' });
            break;
          }
          // R-5: reject a second controller while the host is already paired.
          if (target.farsight.peerSocket) { send(socket, MSG.ERROR, { reason: 'busy' }); break; }
          limiter.reset(key);
          // Pair the two sockets for relay.
          socket.farsight.peerSocket = target;
          target.farsight.peerSocket = socket;
          clearIdle(); // controller is now settled
          // R-1: issue ephemeral TURN/ICE credentials only after successful auth —
          // to the controller (post-auth) and to the host right before CONNECT.
          const ice = iceServersFor(cfg);
          send(socket, MSG.ICE_SERVERS, { iceServers: ice });
          send(target, MSG.ICE_SERVERS, { iceServers: ice });
          send(target, MSG.CONNECT, {}); // tell host a controller wants in
          log.event('connect', { targetId: msg.targetId });
          break;
        }
        // R-6: whitelist relayed fields — never forward the raw message wholesale.
        case MSG.OFFER:
        case MSG.ANSWER: {
          const peer = socket.farsight.peerSocket;
          if (peer) send(peer, msg.type, { sdp: msg.sdp });
          break;
        }
        case MSG.CANDIDATE: {
          const peer = socket.farsight.peerSocket;
          if (peer) send(peer, msg.type, { candidate: msg.candidate });
          break;
        }
        default:
          break;
      }
    });

    socket.on('close', () => {
      clearIdle();
      limits.removeConn(ip);
      if (socket.farsight.registered) limits.removeReg(ip);
      if (socket.farsight.id) { log.event('disconnect', { id: socket.farsight.id }); registry.remove(socket.farsight.id); }
      const peer = socket.farsight.peerSocket;
      if (peer) {
        send(peer, MSG.PEER_DISCONNECTED, {});
        peer.farsight.peerSocket = null;
      }
    });
  });

  return { wss, close: () => new Promise((res) => wss.close(res)) };
}

// Allow `node src/server.js` to run standalone (cross-platform entrypoint check).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  createSignalingServer({ config: cfg });
  console.log(`[signaling] listening on ws://0.0.0.0:${cfg.port}`);
}
