// packages/signaling-server/src/server.js
import { WebSocketServer } from 'ws';
import { pathToFileURL } from 'node:url';
import { MSG, parseMessage, buildMessage } from '@farsight/shared/protocol';
import { generateHostId } from '@farsight/shared/host-id';
import { isJobId } from '@farsight/shared/transfer-protocol';
import { constantTimeEqual } from '@farsight/shared/password';
import { makeTurnCredential } from '@farsight/shared/turn';
import { createRegistry } from './registry.js';
import { createRateLimiter } from './rate-limit.js';
import { createConnectionLimits } from './limits.js';
import { createLogger } from './log.js';
import { loadConfig } from './config.js';
import { clientIp } from './client-ip.js';
import { createTokenBucket } from './token-bucket.js';

const IDLE_TIMEOUT_MS = 15000;

// Compute the ICE server list from config: STUN always, TURN (and optional TLS
// turns:) with ephemeral HMAC creds when a shared secret is configured. Both
// TURN urls share one credential via an RTCIceServer.urls array. Empty when no
// TURN is configured (LAN dev).
function iceServersFor(cfg, flowIndex) {
  if (!cfg.turnUri) return [];
  const stunUri = cfg.turnUri.replace('turn:', 'stun:');
  if (!cfg.turnSecret) return [{ urls: stunUri }];
  const { username, credential } = makeTurnCredential({ secret: cfg.turnSecret, ttlSeconds: cfg.turnTtlSeconds, flowIndex });
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
  // SP3 (spec §4): multiplexed transfer sessions, keyed by an unguessable
  // sessionId, decoupled from the 1:1 control peerSocket pairing.
  const sessions = new Map();
  const limiter = createRateLimiter({ maxAttempts: cfg.maxAttempts, windowMs: cfg.windowMs });
  // L-1: bounds CONNECT attempts (offline target, bad password, or success)
  // per source IP, so probing for live host IDs is capped regardless of
  // hit/miss outcome — separate from the per-(host,IP) password lockout above.
  const connectLimiter = createRateLimiter({ maxAttempts: cfg.connectBurst, windowMs: cfg.windowMs });
  const limits = createConnectionLimits();
  const log = createLogger();

  // L-4: periodic GC so long-running servers don't accumulate stale limiter
  // entries from one-off attackers/probes that never come back to age out.
  const gc = setInterval(() => { limiter.sweep(); connectLimiter.sweep(); }, 60000);
  if (gc.unref) gc.unref();

  const send = (socket, type, payload) => {
    if (socket && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(buildMessage(type, payload)));
    }
  };

  wss.on('connection', (socket, req) => {
    // R-4/H-1: capture the source IP at connection time so lockout can be
    // keyed by `targetId|sourceIp` (per attacker, not per host). Behind a
    // trusted reverse proxy, req.socket.remoteAddress is the proxy's constant
    // IP — clientIp() reads X-Forwarded-For instead, but only when trustProxy
    // is explicitly configured (untrusted XFF is spoofable).
    const ip = clientIp({
      remoteAddress: req?.socket?.remoteAddress,
      forwardedFor: req?.headers?.['x-forwarded-for'],
      trustProxy: cfg.trustProxy,
    }) ?? 'unknown';

    // R-2: per-IP connection cap — reject floods before allocating state.
    if (!limits.canConnect(ip)) { socket.close(); return; }
    limits.addConn(ip);

    // L-2: per-socket message rate limit — a token bucket generous enough
    // for normal ICE-candidate bursts, tight enough to stop message floods.
    const bucket = createTokenBucket({ capacity: cfg.msgBurst, refillPerSec: cfg.msgPerSec });

    socket.farsight = { id: null, password: null, peerSocket: null, ip, registered: false, bucket, version: null, acceptsLinked: false, transferSessionId: null };

    // R-2: close a socket that neither registers (host) nor pairs (controller)
    // within the idle window, so half-open sockets can't accumulate.
    let idleTimer = setTimeout(() => {
      if (!socket.farsight.id && !socket.farsight.peerSocket) socket.close();
    }, IDLE_TIMEOUT_MS);
    if (idleTimer.unref) idleTimer.unref();
    const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };

    socket.on('message', (raw) => {
      // L-2: enforce the per-socket rate limit before doing any parse work.
      if (!socket.farsight.bucket.tryRemove()) return;

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
          // SP1: record the host's app version so it can be relayed to a
          // connecting controller (and, later, surfaced to the console). Only a
          // string is kept — anything else is ignored.
          socket.farsight.version = typeof msg.version === 'string' ? msg.version : null;
          // Connect-from-console (SP2): advertise that this host accepts
          // password-free "linked" connects from the owner's own account devices.
          // The real auth is the E2E keypair handshake downstream (see
          // shared/connection-auth.js) — this only relaxes the signaling password
          // gate. Boolean only; anything else is ignored.
          socket.farsight.acceptsLinked = msg.acceptsLinked === true;
          registry.add(id, socket);
          send(socket, MSG.REGISTERED, { id });
          log.event('register', { id });
          break;
        }
        case MSG.CONNECT: {
          // L-1: bound CONNECT attempts per source IP before touching the
          // registry, so probing for live host IDs (offline target, bad
          // password, or success — every outcome counts) is capped by a
          // uniform response that leaks nothing about which IDs are live.
          const ipKey = socket.farsight.ip;
          // SP1: record the controller's app version (string only) so it can be
          // relayed to the host on the CONNECT it receives.
          socket.farsight.version = typeof msg.version === 'string' ? msg.version : null;
          if (connectLimiter.isLocked(ipKey)) { send(socket, MSG.ERROR, { reason: 'rate_limited' }); break; }
          connectLimiter.recordFailure(ipKey);
          const target = registry.get(msg.targetId);
          if (!target) { send(socket, MSG.ERROR, { reason: 'host_offline' }); break; }
          // R-4: composite lockout key scopes attempts to (host, this controller IP).
          const key = `${msg.targetId}|${socket.farsight.ip}`;
          if (limiter.isLocked(key)) { log.event('locked', { id: msg.targetId }); send(socket, MSG.ERROR, { reason: 'locked' }); break; }
          // A linked connect skips the password gate — but only if the host
          // advertised acceptsLinked. The host authenticates the peer end-to-end
          // via the device-keypair handshake; signaling stays account-oblivious.
          const wantsLinked = msg.linked === true && target.farsight.acceptsLinked === true;
          if (!wantsLinked) {
            if (!target.farsight.password || !constantTimeEqual(String(msg.password ?? ''), target.farsight.password)) {
              limiter.recordFailure(key);
              log.event('auth_fail', { id: msg.targetId, reason: 'bad_password' });
              send(socket, MSG.ERROR, { reason: 'bad_password' });
              break;
            }
          }
          // SP3 (spec §4.2): a transfer session does NOT consume the target's
          // control peerSocket — a host can serve a transfer while being
          // controlled. Auth (password/linked + lockouts) has already passed above.
          if (msg.kind === 'transfer') {
            limiter.reset(key);
            let sessionId;
            do { sessionId = generateHostId(); } while (sessions.has(sessionId));
            const sess = { a: socket, b: null, targetId: msg.targetId, timer: null, flowIndex: undefined };
            sessions.set(sessionId, sess);
            socket.farsight.transferSessionId = sessionId;
            clearIdle(); // the initiator is now settled into a session
            sess.timer = setTimeout(() => {
              if (sessions.get(sessionId) === sess && !sess.b) {
                sessions.delete(sessionId);
                // Drop the initiator's back-pointer so a later close can't delete
                // an unrelated session that reused this id (no leaked/wrong-swept sessions).
                if (socket.farsight.transferSessionId === sessionId) socket.farsight.transferSessionId = null;
                send(socket, MSG.ERROR, { reason: 'transfer_timeout' });
              }
            }, cfg.sessionTimeoutMs ?? 15000);
            if (sess.timer.unref) sess.timer.unref();
            // Plan 2 Task 6 (SP3 multi-flow): whitelisted pass-through so N
            // parallel flows can be grouped by the receiver into one logical
            // transfer with a single consent. Relayed verbatim, never
            // interpreted here — pairing/session logic above is unchanged,
            // each flow is still its own session/socket pair. R-6: omit any
            // field that fails validation rather than forwarding it raw.
            const groupId = isJobId(msg.groupId) ? msg.groupId : undefined;
            const flowIndex = Number.isInteger(msg.flowIndex) && msg.flowIndex >= 0 ? msg.flowIndex : undefined;
            const flowCount = Number.isInteger(msg.flowCount) && msg.flowCount >= 1 ? msg.flowCount : undefined;
            // Initiator-authoritative: this initiating socket's own claimed
            // flowIndex is what determines the per-flow TURN username handed
            // to both ends of THIS flow at ATTACH below — never trust a value
            // the attacher claims for itself later (see MSG.ATTACH).
            sess.flowIndex = flowIndex;
            send(target, MSG.TRANSFER_REQUEST, {
              sessionId,
              peerVersion: socket.farsight.version || undefined,
              linked: wantsLinked || undefined,
              groupId,
              flowIndex,
              flowCount,
            });
            log.event('transfer_request', { targetId: msg.targetId });
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
          // SP1: relay each peer's app version to the other (undefined when the
          // peer is an older build that sent none — JSON omits the field).
          send(socket, MSG.ICE_SERVERS, { iceServers: ice, peerVersion: target.farsight.version || undefined });
          send(target, MSG.ICE_SERVERS, { iceServers: ice });
          // tell the host a controller wants in; `linked` signals it to run the
          // E2E device-keypair handshake (and skip the password) for this peer.
          send(target, MSG.CONNECT, { peerVersion: socket.farsight.version || undefined, linked: wantsLinked || undefined });
          log.event('connect', { targetId: msg.targetId });
          break;
        }
        case MSG.ATTACH: {
          // SP3 (spec §4.2): a transfer worker joins an existing session by its
          // unguessable sessionId (delivered only to the target via TRANSFER_REQUEST).
          const sess = sessions.get(msg.sessionId);
          if (!sess || sess.b) { send(socket, MSG.ERROR, { reason: 'no_session' }); break; }
          if (sess.timer) { clearTimeout(sess.timer); sess.timer = null; }
          socket.farsight.version = typeof msg.version === 'string' ? msg.version : null;
          sess.b = socket;
          socket.farsight.transferSessionId = msg.sessionId;
          // Cross-link so the existing OFFER/ANSWER/CANDIDATE relay routes between them.
          socket.farsight.peerSocket = sess.a;
          sess.a.farsight.peerSocket = socket;
          clearIdle();
          // Both ends of THIS flow share one relay allocation, so they must
          // get the SAME per-flow TURN username — derive it from the
          // initiator-authoritative sess.flowIndex (never the attacher's own
          // claim), so different flows (different sess.flowIndex) land on
          // different usernames and don't collide against coturn's user-quota.
          const ice = iceServersFor(cfg, sess.flowIndex);
          send(sess.a, MSG.ICE_SERVERS, { iceServers: ice, peerVersion: socket.farsight.version || undefined });
          send(socket, MSG.ICE_SERVERS, { iceServers: ice });
          log.event('transfer_attach', { sessionId: msg.sessionId });
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
        case MSG.UPDATE_PASSWORD: {
          // A registered host rotates its OWN session password. Only mutates
          // this socket's registration; ignored from unregistered sockets.
          if (socket.farsight.registered && typeof msg.password === 'string') {
            socket.farsight.password = msg.password;
          }
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
      const sid = socket.farsight.transferSessionId;
      if (sid) {
        const sess = sessions.get(sid);
        if (sess) { if (sess.timer) clearTimeout(sess.timer); sessions.delete(sid); }
      }
      const peer = socket.farsight.peerSocket;
      if (peer) {
        send(peer, MSG.PEER_DISCONNECTED, {});
        peer.farsight.peerSocket = null;
      }
    });
  });

  return {
    wss,
    close: () => { clearInterval(gc); return new Promise((res) => wss.close(res)); },
  };
}

// Allow `node src/server.js` to run standalone (cross-platform entrypoint check).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  createSignalingServer({ config: cfg });
  console.log(`[signaling] listening on ws://0.0.0.0:${cfg.port}`);
}
