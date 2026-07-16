// packages/shared/src/account-service.js
// Main-process account service (SP2), shared by BOTH apps (controller console +
// host enrollment). Wires the account client + session + encrypted token store
// into the operations the IPC layer exposes to a renderer (login / logout / status
// / fleet), and drives the presence heartbeat (SP2 S2.5) so a signed-in app shows
// up online + versioned in the owner's fleet console. Runtime-agnostic: safeStorage,
// fs, fetch, the app version, and the scheduler are all injected, so each app's
// main.js constructs it with the real Electron safeStorage, node:fs, global fetch,
// and app.getVersion(); tests inject fakes.
//
// Connect-from-console (SP2 §4.4): also owns this device's account-issued Ed25519
// keypair — generated once, persisted encrypted (safeStorage), public half uploaded
// to the account server — and exposes the main-only crypto ops (sign / verify /
// is-this-key-one-of-my-account's-devices) the E2E connection-auth handshake needs.

import { createAccountClient } from './account-client.js';
import { createAccountSession } from './account-session.js';
import { createTokenStore } from './account-token-store.js';
import { createHeartbeat } from './account-heartbeat.js';
import { createDeviceKeyStore } from './device-key-store.js';
import { generateDeviceKeyPair, signMessage, verifyMessage } from './device-keypair.js';

// Verbose diagnostic logging (see docs/private/superpowers): sign-in state
// changes only — never the access/refresh token or password. The session (login
// resume / refresh) and heartbeat sub-modules get their own child scopes.
function noopLog() { const n = { debug() {}, info() {}, warn() {}, error() {}, child: () => n }; return n; }

// The maintainer's deployed account service (SP2). Overridable via config/env.
export const DEFAULT_ACCOUNT_URL = 'https://auth.sovexa.org';

export function createAccountService({
  baseUrl = DEFAULT_ACCOUNT_URL,
  safeStorage, fs, filePath, deviceKeyFilePath, fetch, now,
  version, intervalMs, setInterval: setI, clearInterval: clearI,
  getSignalingId, log = noopLog(),
} = {}) {
  const client = createAccountClient({ baseUrl, fetch });
  const store = createTokenStore({ safeStorage, fs, filePath });
  const session = createAccountSession({ client, store, ...(now ? { now } : {}), log });
  // Connect-from-console: this device's keypair store. Falls back to a filePath
  // sibling if a dedicated path isn't given, so older callers keep working.
  const keyStore = createDeviceKeyStore({ safeStorage, fs, filePath: deviceKeyFilePath ?? `${filePath}.key` });

  let currentSignalingId = null;
  let directiveCb = null; // app-registered handler for management directives (S2.7)
  const heartbeat = createHeartbeat({
    session, client, version,
    getSignalingId: getSignalingId ?? (() => currentSignalingId),
    onDirective: (data) => { if (directiveCb) directiveCb(data); },
    ...(intervalMs ? { intervalMs } : {}),
    ...(setI ? { setInterval: setI } : {}),
    ...(clearI ? { clearInterval: clearI } : {}),
    log: log.child('heartbeat'),
  });

  // This device's keypair — loaded once, generated + persisted on first use.
  let keys = null;
  function ensureKeys() {
    if (keys) return keys;
    keys = keyStore.load();
    if (!keys) {
      keys = generateDeviceKeyPair();
      keyStore.save(keys);
    }
    return keys;
  }

  // Best-effort: enroll this device's public key so peers can verify it. Swallows
  // failures (offline / transient) like the heartbeat — retried on next resume.
  async function ensureUploaded(token) {
    try {
      const { publicKey } = ensureKeys();
      await client.uploadPublicKey({ accessToken: token, publicKey });
    } catch { /* retried on the next login/resume */ }
  }

  // The saved-hosts fleet — devices under the account with presence/version.
  async function fleet() {
    const token = await session.getAccessToken();
    if (!token) return { ok: false, error: 'not_signed_in' };
    return client.listDevices({ accessToken: token });
  }

  return {
    async login(input) {
      const res = await session.login(input);
      if (res.ok) {
        log.info('logged in');
        const token = await session.getAccessToken();
        if (token) await ensureUploaded(token);
        await heartbeat.start(); // report presence once signed in
      }
      return res;
    },
    async logout() {
      heartbeat.stop();
      // Revoke this device server-side so it leaves the owner's fleet (and its
      // refresh token dies) — not just a local token wipe. Best-effort: if we're
      // offline or it fails, still clear locally so sign-out always completes.
      const deviceId = session.getDeviceId();
      if (deviceId) {
        const token = await session.getAccessToken();
        if (token) {
          try { await client.revokeDevice({ accessToken: token, deviceId }); } catch { /* clear locally anyway */ }
        }
      }
      const result = await session.logout();
      log.info('logged out');
      return result;
    },
    register: (input) => client.register(input),
    verifyEmail: (input) => client.verifyEmail(input),
    resendVerification: (input) => client.resendVerification(input),
    requestPasswordReset: (input) => client.requestPasswordReset(input),

    // Cheap sign-in check (also resumes a persisted session on first call, and
    // starts heartbeating so a resumed session begins reporting presence).
    async status() {
      const token = await session.getAccessToken();
      if (token) {
        await ensureUploaded(token); // enroll our key if a fresh install resumed
        await heartbeat.start();
      }
      return { signedIn: !!token };
    },

    fleet,

    // ── connect-from-console: rendezvous + main-only crypto for the handshake ──
    // The host publishes its current signaling id through the heartbeat; main
    // calls this whenever the renderer (re)registers with signaling.
    setSignalingId(id) {
      currentSignalingId = id ? String(id) : null;
      heartbeat.beat(); // push an immediate beat so the console learns the fresh id
    },
    // This device's public key (for the handshake HELLO/CHALLENGE).
    getPublicKey() { return ensureKeys().publicKey; },
    // This install's account device id (null before login/resume). Bound into the
    // handshake transcript so both peers agree on who's who.
    getDeviceId() { return session.getDeviceId(); },

    // ── remote update (S2.7) ──────────────────────────────────────────────────
    // Console: set a converge-to target version on one of the owner's devices
    // (null clears). The host acts on it via its heartbeat directive.
    async requestDeviceUpdate(deviceId, targetVersion) {
      const token = await session.getAccessToken();
      if (!token) return { ok: false, error: 'not_signed_in' };
      return client.requestUpdate({ accessToken: token, deviceId, targetVersion: targetVersion ?? null });
    },
    // Host: register a handler for management directives delivered on the heartbeat
    // response (e.g. { targetVersion }). Called on each beat while signed in.
    onUpdateDirective(cb) { directiveCb = typeof cb === 'function' ? cb : null; },
    // Sign the handshake transcript with this device's private key.
    signTranscript(message) { return signMessage(ensureKeys().privateKey, String(message)); },
    // Verify a peer's transcript signature.
    verifyTranscript(publicKey, message, signature) {
      return verifyMessage(String(publicKey), String(message), String(signature));
    },
    // Is this public key one of the owner's own account devices? Reads the live
    // owner-scoped fleet; fail-closed on any error (unknown key → not trusted).
    async isAccountPublicKey(publicKey) {
      const res = await fleet();
      if (!res.ok) return false;
      const devices = (res.data && res.data.devices) || [];
      return devices.some((d) => d.publicKey && d.publicKey === publicKey);
    },
  };
}
