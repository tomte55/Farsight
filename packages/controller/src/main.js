// packages/controller/src/main.js
import { app, BrowserWindow, desktopCapturer, screen, ipcMain, clipboard, dialog, shell, safeStorage, globalShortcut, Tray, Menu, nativeImage } from 'electron';
// electron-updater is CommonJS: a named ESM import fails in the packaged app's
// ESM loader, so use the default import + destructure interop.
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { createInjector } from './input-injector.js';
import { createNutFacade } from './nut-facade.js';
import { registerPanicKey } from './panic.js';
import { listDisplays } from './capture.js';
import { generateSessionPassword } from '@farsight/shared/password';
import { windowAttentionPlan } from './window-attention.js';
import { createAppLogger } from '@farsight/shared/app-log';
import { parseConfig, serializeConfig, validateSignalingUrl, resolveSignalingUrl, resolveParallelConnections, resolveRateLimit } from '@farsight/shared/config';
import { createUpdater } from '@farsight/shared/updater';
import { shouldConverge } from '@farsight/shared/update-policy';
import { createAccountService, DEFAULT_ACCOUNT_URL } from './account.js';
import { revealWindow } from './reveal-window.js';
import { createSessionWindow } from './session-window.js';
import { buildTrayMenuTemplate } from './tray-menu.js';
import { createLifecycle } from './lifecycle.js';
// Verbose diagnostic logging: consent-gated upload of a redaction-safe log
// bundle for support triage (see docs/SECURITY.md).
import { buildDiagnosticsBundle } from '@farsight/shared/diagnostics-bundle';
// SP3 file transfer (send path): the orchestrator/queue/jobs-store pipeline
// (createTransferService) plus the manifest-building I/O it's fed with.
import { createTransferWorker } from './transfer-worker.js';
import { createTransferService } from '@farsight/shared/transfer-service';
import { createJobsStore } from '@farsight/shared/jobs-store';
import { walkSource } from '@farsight/shared/transfer-io';
import { buildManifest } from '@farsight/shared/transfer-manifest';
import { newJobId } from '@farsight/shared/transfer-queue';
// Plan 3 Task 4 (SP3 multi-flow): the pure send/receive assembly helpers (no
// electron import — unit-testable directly) and the group-rendezvous
// coordinator that folds N incoming per-flow TRANSFER_REQUESTs into one
// consent/receive.
import { assembleSendFlows, assembleReceiveGroup, dispatchReceiveFlowJoin } from './transfer-channel-assembly.js';
import { createGroupRendezvous } from '@farsight/shared/transfer-group-rendezvous';
import { createFaultHooks } from './transfer-fault-hooks.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Plan-1b Task 4: real-wire fault-injection, gated behind FARSIGHT_TEST_HOOKS=1.
// DISABLED by default (and in every production build, which never sets the flag):
// faultHooks then registers nothing, the ft-test:fault IPC handler below is never
// registered, and createTransferWorker gets no test-hook flag — so the fault
// machinery is entirely absent, not merely dormant. The harness sets the env var
// to drive killWorker/dropFlowSocket/injectOversizeCtrl/stallFlow against a live
// transfer's individual flows.
const TEST_HOOKS = process.env.FARSIGHT_TEST_HOOKS === '1';
const faultHooks = createFaultHooks({ enabled: TEST_HOOKS });

// Register a freshly-created transfer worker under its (side, flowIndex) so the
// fault IPC can address it, and unregister it when it closes (a re-dial replaces
// the slot; the registry keeps only the current occupant). A no-op that returns
// the worker untouched when hooks are disabled — zero production overhead.
function trackWorker(side, flowIndex, worker) {
  if (!faultHooks.enabled) return worker;
  faultHooks.register(side, flowIndex, worker);
  const origClose = worker.close.bind(worker);
  worker.close = async () => { faultHooks.unregister(side, flowIndex, worker); return origClose(); };
  return worker;
}

// Account service (SP2 saved-hosts console) — lazily built so safeStorage /
// app.getPath are ready. The refresh token is stored encrypted under userData;
// the account URL defaults to the deployed service (env-overridable for dev).
let accountService = null;
function getAccountService() {
  if (!accountService) {
    accountService = createAccountService({
      baseUrl: process.env.FARSIGHT_ACCOUNT_URL || DEFAULT_ACCOUNT_URL,
      safeStorage,
      fs: nodeFs,
      filePath: path.join(app.getPath('userData'), 'account-token.enc'),
      deviceKeyFilePath: path.join(app.getPath('userData'), 'device-key.enc'),
      fetch: globalThis.fetch,
      version: app.getVersion(), // reported to the fleet console via the presence heartbeat
      log: log?.child('account'),
    });
  }
  return accountService;
}
// Connect-from-console (SP2 §4.4): main-only device-keypair crypto for the E2E
// handshake, bridged to the renderer that drives the WebRTC 'auth' channel.
ipcMain.handle('conn-auth:public-key', () => getAccountService().getPublicKey());
ipcMain.handle('conn-auth:device-id', () => getAccountService().getDeviceId());
ipcMain.handle('conn-auth:sign', (_e, message) => getAccountService().signTranscript(message));
ipcMain.handle('conn-auth:verify', (_e, publicKey, message, signature) => getAccountService().verifyTranscript(publicKey, message, signature));
ipcMain.handle('conn-auth:is-account-key', (_e, publicKey) => getAccountService().isAccountPublicKey(publicKey));
ipcMain.handle('conn-auth:is-transfer-peer-key', (_e, publicKey) => getAccountService().isTransferPeerKey(publicKey));
// Cached sign-in flag so the (synchronously-built) tray menu can gate the
// diagnostics item without awaiting the account service on every rebuild.
// Kept in sync from the three places sign-in state can change.
let accountLoggedIn = false;
ipcMain.handle('account:status', async () => {
  const res = await getAccountService().status();
  accountLoggedIn = !!res.signedIn;
  refreshTrayMenu();
  return res;
});
ipcMain.handle('account:login', async (_e, input) => {
  // Name this device by its machine hostname (authoritative — main owns os), not
  // a hardcoded label. Before this the renderer sent deviceName:'Controller', so
  // every device in a fleet showed up as "Controller" and was indistinguishable.
  // Forced here so the renderer can't override it.
  const res = await getAccountService().login({ ...input, deviceName: os.hostname() });
  accountLoggedIn = !!res.ok;
  refreshTrayMenu();
  return res;
});
ipcMain.handle('account:logout', async () => {
  const res = await getAccountService().logout();
  accountLoggedIn = false;
  refreshTrayMenu();
  return res;
});
ipcMain.handle('account:register', (_e, input) => getAccountService().register(input));
ipcMain.handle('account:resend-verification', (_e, input) => getAccountService().resendVerification(input));
ipcMain.handle('account:request-password-reset', (_e, input) => getAccountService().requestPasswordReset(input));
ipcMain.handle('account:fleet', () => getAccountService().fleet());
ipcMain.handle('account:contacts', () => getAccountService().contacts());
ipcMain.handle('account:contact-add', (_e, input) => getAccountService().addContact(input?.email));
ipcMain.handle('account:contact-accept', (_e, input) => getAccountService().acceptContact(input?.contactId));
ipcMain.handle('account:contact-decline', (_e, input) => getAccountService().declineContact(input?.contactId));
// Remote update (S2.7): set a converge-to target version on a fleet device.
ipcMain.handle('account:request-update', (_e, input) => getAccountService().requestDeviceUpdate(input?.deviceId, input?.targetVersion));
// Fleet console: remove a stale/old device from the owner's fleet (server-side revoke).
ipcMain.handle('account:revoke-device', (_e, input) => getAccountService().revokeDevice(input?.deviceId));

// SP3 file transfer (send AND receive). Each transfer gets its own
// createTransferWorker() — a hidden BrowserWindow owning a DEDICATED
// RTCPeerConnection + signaling socket (see transfer-worker.js), independent of
// the main control session's peer. The jobs-store persists progress under
// userData/transfers so a send survives across app restarts. v2: this app now
// also RECEIVES — an incoming TRANSFER_REQUEST (relayed on the renderer's
// host-registration socket) routes to transfer:incoming → startReceive, with a
// real consent prompt (requestReceiveConsent); own-fleet pushes auto-accept.
let jobsStore = null;
function getJobsStore() {
  if (!jobsStore) jobsStore = createJobsStore({ dir: path.join(app.getPath('userData'), 'transfers') });
  return jobsStore;
}

// Where received files land. A discoverable, user-owned location (Downloads/
// Farsight/Received) — not a hidden userData folder — since the whole point of
// receiving is that the user then opens the files. Mirrors the retired host.
// The user can override the folder in Settings; the value is config-backed and
// resolved PER RECEIVE (see ensureReceivedFilesDir passed to the transfer
// service), so a change takes effect on the next transfer.
function defaultReceivedFilesDir() {
  return path.join(app.getPath('downloads'), 'Farsight', 'Received');
}
function receivedFilesDir() {
  const stored = readStoredConfig();
  const chosen = stored.receivedFilesDir;
  // Fail safe to the default on anything unusable (unset/relative/garbage) so a
  // corrupt config can never point transfers at a nonsensical location.
  if (typeof chosen === 'string' && chosen.trim() !== '' && path.isAbsolute(chosen)) return chosen;
  return defaultReceivedFilesDir();
}
// Resolve AND create the destination; passed as `transferDir` to the transfer
// service so each receive lands in (and lazily creates) the CURRENT folder.
function ensureReceivedFilesDir() {
  const d = receivedFilesDir();
  try { nodeFs.mkdirSync(d, { recursive: true }); } catch (err) { log?.child('transfer').warn(`could not create received-files dir: ${err.message}`); }
  return d;
}
// Free bytes available to the user on the destination volume. The dir may not
// exist yet (created lazily at receive), so statfs the nearest existing ancestor
// — volume free space is identical for any path on that volume. null on failure
// (the UI then shows the path with no space line and never blocks on it).
function freeBytesAt(startDir) {
  let d = startDir;
  for (let i = 0; i < 40; i++) {
    try {
      const s = nodeFs.statfsSync(d);
      return s.bavail * s.bsize;
    } catch {
      const parent = path.dirname(d);
      if (parent === d) return null;
      d = parent;
    }
  }
  return null;
}

// Consent round-trip for an INCOMING transfer (v2: the unified app can now
// receive, not just send). transfer-orchestrator's createReceiver calls
// consent({jobId, manifest}) with the REAL sender-assigned jobId — use it as the
// correlation id so the prompt, the IPC round-trip, and the persisted record all
// agree. Own-fleet offers auto-accept inside transfer-service (peerAuth tier),
// so this human prompt only fires for contacts / ad-hoc peers.
const pendingConsent = new Map(); // jobId -> resolve(boolean)
function requestReceiveConsent({ jobId, manifest }) {
  log?.child('transfer').info(`consent prompt shown job=${jobId} files=${manifest?.totalFiles} bytes=${manifest?.totalBytes}`);
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) { resolve(false); return; }
    pendingConsent.set(jobId, resolve);
    const destDir = receivedFilesDir();
    mainWindow.webContents.send('transfer:consent-request', { jobId, manifest, destDir, freeBytes: freeBytesAt(destDir) });
    // Surface the prompt: the app is a tray app that may be hidden/covered, and an
    // unseen prompt is a silently-dropped transfer (same reasoning as an incoming
    // control CONNECT).
    bringWindowToAttention();
  });
}
ipcMain.on('transfer:respond-consent', (_e, input) => {
  const { jobId, accept } = input || {};
  log?.child('transfer').info(`consent responded job=${jobId} accept=${!!accept}`);
  const resolve = pendingConsent.get(jobId);
  if (!resolve) return;
  pendingConsent.delete(jobId);
  resolve(!!accept);
});

// Freshly resolve the configured signaling URL at worker-open time (env
// overrides the stored value) — factored out since it's now needed at THREE
// call sites (the single-flow path, the multi-flow send assembly, and the
// per-flow attach opener below) instead of just one.
function currentSignalingUrl() {
  const stored = readStoredConfig();
  return resolveSignalingUrl({
    envUrl: process.env.FARSIGHT_SIGNALING_URL,
    storedUrl: stored.signalingUrl,
  }).url;
}

// Plan 3 Task 4 (SP3 multi-flow RECEIVE): opens ONE attaching transfer worker
// for a single flow of a (possibly multi-flow) incoming transfer. This is the
// group-rendezvous coordinator's `openFlow` — i.e. exactly what the OLD
// openChannel attach branch used to do inline, now factored out so it can run
// once per flow (N times for a real multi-flow group) instead of once per
// receive. `flowIndex` rides along on the returned handle (not just the
// worker's own bookkeeping) so onGroupReady below can line flows up in
// flowIndex order — flows are NOT guaranteed to connect in order (each is an
// independent WebRTC/signaling race), but the paired sender always treats its
// flowIndex-0 worker as `ctrl` (assembleSendFlows), so the receiver must agree
// on which flow that is or it listens for the manifest OFFER on the wrong
// data channel.
function openAttachFlow({ sessionId, flowIndex, groupId, linked }) {
  const worker = trackWorker('receive', flowIndex, createTransferWorker({ onLog: (obj) => log?.child('ft-worker').info(JSON.stringify(obj)), testHooks: TEST_HOOKS }));
  let rendezvousErrorCb = null;
  worker.onSessionState((state) => {
    if (typeof state === 'string' && state.startsWith('error:') && rendezvousErrorCb) {
      rendezvousErrorCb(state.slice('error:'.length));
    }
  });
  let resolvePeerAuth;
  const peerAuth = new Promise((res) => { resolvePeerAuth = res; });
  if (!linked) resolvePeerAuth({ tier: null });
  worker.onPeerAuth(async ({ publicKey }) => {
    let tier = null;
    try { tier = await getAccountService().classifyPublicKey(publicKey); } catch { tier = null; }
    resolvePeerAuth({ tier, publicKey });
  });
  worker.startRendezvous({ role: 'attach', signalingUrl: currentSignalingUrl(), sessionId, linked: !!linked, version: app.getVersion(), groupId, flowIndex });
  return {
    channel: worker.channel,
    close: async () => worker.close(),
    onRendezvousError: (cb) => { rendezvousErrorCb = cb; },
    peerAuth,
    linked: !!linked,
    flowIndex,
    // Carried so a rolling-join handle (delivered post-ready via onFlowJoin) can
    // be routed to the RIGHT active receive — the receiver is keyed by the
    // group's sessionId (== groupId), which onFlowJoin only sees via the handle.
    groupId,
  };
}

// Bundles assembled by onGroupReady below, keyed by the sessionId
// getTransferService().startReceive() is invoked with (the group's groupId, or
// the lone sessionId for a legacy request) — so THIS module's openChannel
// attach branch never opens a worker itself anymore; it just hands back what
// the coordinator already opened. Deleted on pickup (one-shot).
const pendingGroupReceives = new Map();

// Every incoming TRANSFER_REQUEST (main.js's transfer:incoming handler, one
// per flow) is fed through this coordinator instead of calling startReceive
// directly. A legacy request (no groupId/flowCount) fires onGroupReady
// immediately with a single flow — see transfer-group-rendezvous.js — so this
// covers BOTH the plain single-flow receive and a real multi-flow group
// uniformly.
const groupRendezvous = createGroupRendezvous({
  openFlow: ({ sessionId, flowIndex, groupId, linked }) => openAttachFlow({ sessionId, flowIndex, groupId, linked }),
  // Resilient multi-flow rolling-join: once a group has already fired (its
  // receive is under way), a later offer for the same groupId — a re-dialed
  // replacement slot, or a brand-new flowIndex added late — is opened and
  // delivered here instead of being dropped. Route it into the LIVE receiver:
  // flowIndex 0 swaps the ctrl channel (setCtrl), any other joins the bulk
  // router (addFlow). The receiver is keyed by the group's sessionId (== groupId,
  // set by onGroupReady below) and only present once the receive is ACTIVE — if
  // it isn't (a join that raced ahead of consent, or arrived after teardown),
  // there's nothing to route into, so close the orphan handle (the sender's
  // supervisor re-dials).
  onFlowJoin: (handle, flowIndex) => {
    const sink = getTransferService().getReceiveFlowSink(handle && handle.groupId);
    if (sink) {
      dispatchReceiveFlowJoin(sink, handle.channel, flowIndex);
      // Important #2: hand the joined handle's close to the active receive so its
      // hidden worker window is swept on teardown (it is NOT one of the
      // assembleReceiveGroup handles the receive already closes) — else every
      // rolling-join leaks a BrowserWindow that keeps the app alive.
      if (handle && typeof handle.close === 'function' && typeof sink.retain === 'function') sink.retain(handle.close);
      log?.child('transfer').info(`rolling-join flow=${flowIndex} group=${handle.groupId}`);
    } else {
      log?.child('transfer').warn(`rolling-join dropped (no active receive) flow=${flowIndex} group=${handle && handle.groupId}`);
      if (handle && typeof handle.close === 'function') { Promise.resolve(handle.close()).catch(() => {}); }
    }
  },
  onGroupReady: ({ groupId, flowCount, flows }) => {
    const linked = !!(flows[0] && flows[0].linked);
    const bundle = flowCount > 1 ? assembleReceiveGroup(flows) : flows[0];
    // C1 (I1): assembleReceiveGroup returns null for a partial group with no
    // flowIndex-0 handle -- there is no channel the manifest OFFER could ever
    // arrive on, so starting the receive would hang forever waiting for it.
    // Fail clean instead: close whatever DID connect and release the group
    // (never call startReceive, never populate pendingGroupReceives).
    if (!bundle) {
      log?.child('transfer').warn(`transfer group aborted (no flow 0) group=${groupId} flows=${flows.length}/${flowCount}`);
      Promise.all(flows.map((f) => f.close())).catch(() => {});
      groupRendezvous.cancel(groupId);
      return;
    }
    const sessionId = groupId; // correlates with the openChannel(attach) lookup below
    pendingGroupReceives.set(sessionId, bundle);
    log?.child('transfer').info(`transfer group ready group=${groupId} flows=${flows.length}/${flowCount}`);
    getTransferService().startReceive({ rendezvous: { sessionId, linked } })
      .catch((err) => log?.child('transfer').warn(`receive failed: ${err?.message || err}`))
      .finally(() => groupRendezvous.cancel(groupId)); // Task 2 review note: else the group map entry leaks
  },
});

let transferService = null;
function getTransferService() {
  if (!transferService) {
    // transferDir is the ensure-function, not a captured string: each receive
    // resolves + creates the CURRENT configured folder (so a Settings change
    // takes effect on the next transfer without recreating the service).
    transferService = createTransferService({
      store: getJobsStore(),
      transferDir: ensureReceivedFilesDir,
      consent: requestReceiveConsent,
      // Plan 3 Task 7: the configured "Rate limit" setting (0 = unlimited)
      // seeds the service's limiter at construction; rate-limit:set below
      // additionally calls setRateLimit() live so a Settings change takes
      // effect on THIS service instance without recreating it.
      rateLimitMbps: rateLimit(),
      // Canonical rendezvous shape (SP3 coherence contract #1), identical to
      // the host's openChannel: transfer-service always calls this as
      // { role, target, sessionId } — 'initiate' carries target (sessionId
      // undefined), 'attach' carries sessionId (target undefined).
      openChannel: async ({ role, target, sessionId, linked, flowCount }) => {
        // Plan 3 Task 4: SEND multi-flow — flowCount>1 opens N parallel
        // transfer workers (one RTCPeerConnection each) sharing one groupId,
        // instead of the single worker below. flowCount<=1 falls through to
        // the EXISTING single-worker path, byte-for-byte unchanged.
        if (role === 'initiate' && Number.isInteger(flowCount) && flowCount > 1) {
          const groupId = newJobId();
          return assembleSendFlows({
            flowCount,
            createWorker: (flowIndex) => trackWorker('send', flowIndex, createTransferWorker({ onLog: (obj) => log?.child('ft-worker').info(JSON.stringify(obj)), testHooks: TEST_HOOKS })),
            makeParams: (flowIndex) => ({
              role: 'initiator',
              signalingUrl: currentSignalingUrl(),
              targetId: target?.id,
              password: target?.password,
              // SP3 Phase 4: own-fleet send — pair password-free and authenticate
              // end-to-end via the device keypair (no session password).
              linked: !!target?.linked,
              version: app.getVersion(),
              groupId, flowIndex, flowCount,
            }),
          });
        }

        // RECEIVE (attach): Plan 3 Task 4 — every incoming TRANSFER_REQUEST is
        // fed through groupRendezvous (see transfer:incoming below), which
        // already opened every flow for this group (openAttachFlow) and handed
        // the assembled bundle here via pendingGroupReceives, keyed by the SAME
        // sessionId this call is invoked with (onGroupReady mints it and calls
        // startReceive itself). This covers legacy single-flow receives too —
        // the coordinator fires onGroupReady immediately for those — so the
        // bundle is always present by the time transfer-service's startReceive
        // reaches this call.
        if (role !== 'initiate') {
          const bundle = pendingGroupReceives.get(sessionId);
          if (bundle) { pendingGroupReceives.delete(sessionId); return bundle; }
          // Defensive fallback only — should be unreachable given the above,
          // but never silently hang a receive if it somehow is.
          log?.child('transfer').warn(`openChannel(attach) found no pre-opened flow for session=${sessionId}`);
          return openAttachFlow({ sessionId, flowIndex: 0, groupId: undefined, linked });
        }

        // ---- existing single-worker SEND path (flowCount<=1), unchanged ----
        const worker = trackWorker('send', 0, createTransferWorker({ onLog: (obj) => log?.child('ft-worker').info(JSON.stringify(obj)), testHooks: TEST_HOOKS }));
        const signalingUrl = currentSignalingUrl();
        // Surface signaling-level rendezvous failures (host_offline, bad_password,
        // transfer_timeout, busy, locked) to the transfer-service so a send fails
        // fast with the real reason instead of hanging in "waiting for approval".
        // The worker reports these as 'error:<reason>' session states.
        let rendezvousErrorCb = null;
        worker.onSessionState((state) => {
          if (typeof state === 'string' && state.startsWith('error:') && rendezvousErrorCb) {
            rendezvousErrorCb(state.slice('error:'.length));
          }
        });
        // A non-linked (ad-hoc/password) send never runs the device-keypair
        // handshake -> resolve null immediately (peerAuth is unused on the send
        // path today, but kept for return-shape parity with attach).
        let resolvePeerAuth;
        const peerAuth = new Promise((res) => { resolvePeerAuth = res; });
        worker.onPeerAuth(async ({ publicKey }) => {
          let tier = null;
          try { tier = await getAccountService().classifyPublicKey(publicKey); } catch { tier = null; }
          resolvePeerAuth({ tier, publicKey });
        });
        worker.startRendezvous({
          role: 'initiator',
          signalingUrl,
          targetId: target?.id,
          password: target?.password,
          // SP3 Phase 4: own-fleet send — pair password-free and authenticate
          // end-to-end via the device keypair (no session password).
          linked: !!target?.linked,
          version: app.getVersion(),
        });
        return {
          channel: worker.channel,
          close: async () => worker.close(),
          onRendezvousError: (cb) => { rendezvousErrorCb = cb; },
          peerAuth,
        };
      },
      onEvent: (ev) => {
        const prog = ev.progress ? ` files=${ev.progress.filesSent ?? ev.progress.filesDone}/${ev.progress.filesTotal}` : '';
        // 'progress' fires ~4x/second on a long transfer — logging it at info
        // floods the rotating sink (2MB x 2 files) and evicts the [ft-worker]
        // counters field diagnostics depend on. Verbose connection detail is
        // debug-level (CLAUDE.md); every other (rarer) lifecycle event stays info.
        const level = ev.type === 'progress' ? 'debug' : 'info';
        log?.child('transfer')[level](`${ev.direction || 'xfer'} ev=${ev.type} job=${ev.jobId}${prog}${ev.reason ? ` reason=${ev.reason}` : ''}`);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('transfer:event', ev);
      },
      // SP3 Phase 4 auto-resume: the watcher resolves an interrupted job's peer to
      // its CURRENT signalingId via the account fleet AND accepted contacts. Fails
      // soft (returns [] until signed in), so starting the watcher on launch is safe.
      getFleet: async () => {
        try {
          const svc = getAccountService();
          const fleetRes = await svc.fleet();
          const fleetDevices = (fleetRes && fleetRes.ok && fleetRes.data && fleetRes.data.devices) || [];
          const own = fleetDevices.map((d) => ({ deviceId: d.id, signalingId: d.signalingId, online: d.online }));
          // A contact peer resumes exactly like an own-fleet peer: match the durable
          // deviceId -> current signalingId. GET /contacts returns one row per contact
          // DEVICE, already carrying deviceId/signalingId/online.
          const contactsRes = await getAccountService().contacts();
          const accepted = (contactsRes && contactsRes.ok && contactsRes.data && contactsRes.data.accepted) || [];
          const peers = accepted.map((c) => ({ deviceId: c.deviceId, signalingId: c.signalingId, online: c.online }));
          return [...own, ...peers];
        } catch { return []; }
      },
    });
  }
  return transferService;
}

ipcMain.handle('transfer:pick-paths', async (_e, mode) => {
  // Windows and Linux cannot show a single dialog that selects BOTH files and
  // directories — when 'openFile' and 'openDirectory' are combined there, the OS
  // silently degrades to a folder-only picker (why the old combined dialog showed
  // no files). So the UI offers two explicit choices and passes the mode here.
  const properties = mode === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'];
  const r = await dialog.showOpenDialog({ properties });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('transfer:send', async (_e, input) => {
  const { target, paths } = input || {};
  if (!target || typeof target.id !== 'string' || !Array.isArray(paths) || paths.length === 0) {
    return { error: 'invalid_request' };
  }
  try {
    const { entries, sources } = await walkSource(paths.map((p) => ({ path: p })));
    const manifest = buildManifest(entries);
    const jobId = newJobId();
    // Plan 3 Task 6: the configured "Parallel connections" setting drives this
    // send's flowCount, unless the caller already asked for a specific one
    // (no caller does today, but a future per-send override should win over
    // the ambient setting — same precedence resolveFlowCount already gives
    // target.flowCount over the service-level default in transfer-service.js).
    // Review fix: an override is routed through resolveParallelConnections too
    // (belt-and-suspenders — transfer-service.js's resolveFlowCount is the last
    // line of defense) so a stray/adversarial target.flowCount (e.g. 1000) can
    // never reach the multi-flow branch un-clamped even at this earlier point.
    const flowCount = Number.isInteger(target.flowCount) && target.flowCount > 0
      ? resolveParallelConnections(target.flowCount) : parallelConnections();
    const sendTarget = { ...target, flowCount };
    log?.child('transfer').info(`send start job=${jobId} target=${target.id} files=${manifest.totalFiles} bytes=${manifest.totalBytes} flowCount=${flowCount}`);
    // Fire-and-forget: startSend()'s promise only resolves once the WHOLE
    // transfer finishes, so awaiting it here would block the renderer's
    // transferSend() call for the entire transfer. Progress is instead
    // delivered incrementally via the 'transfer:event' push above.
    // `sourceRoots: paths` is persisted so an interrupted own-fleet send can be
    // re-walked and auto-resumed after an app restart (SP3 Phase 4).
    getTransferService().startSend({ jobId, manifest, sources, target: sendTarget, sourceRoots: paths })
      .catch((err) => log?.child('transfer').warn(`send failed: ${err?.message || err}`));
    return { jobId, manifest };
  } catch (err) {
    log?.child('transfer').warn(`transfer:send setup failed: ${err.message}`);
    return { error: err.message };
  }
});

ipcMain.handle('transfer:list', () => getTransferService().listJobs());

// Plan-1b Task 4: the fault-injection IPC — REGISTERED ONLY under FARSIGHT_TEST_HOOKS=1
// (a production build never sets the flag, so this handler simply does not exist —
// invoking the channel there rejects with "No handler registered"). The harness
// drives it over CDP via window.farsightIpc.ftTestFault({ cmd, side, flowIndex, ... }).
if (TEST_HOOKS) {
  ipcMain.handle('ft-test:fault', async (_e, input) => {
    try { return await faultHooks.dispatch(input || {}); }
    catch (e) { return { error: (e && e.message) ? e.message : String(e) }; }
  });
}

// SP3 coherence contract #3: cancel() now actually aborts an in-flight send —
// transfer-service.cancel() tears down the active job's channel (via the
// close() returned by openChannel above) in addition to marking the
// persisted job record canceled; a waiting (not-yet-active) job is just
// dropped from the queue.
ipcMain.handle('transfer:cancel', async (_e, jobId) => getTransferService().cancel(jobId));
// Forget a finished/failed job so it leaves the Transfers list (deletes its
// persisted jobs-store record). Refused for a job still in flight — see removeJob.
ipcMain.handle('transfer:remove', async (_e, jobId) => getTransferService().removeJob(jobId));
// Plan 3 Task 7: pause/resume the active send in place, reorder a WAITING
// send within the queue, and read the current queue order (active head
// first) so the renderer can render it without guessing at insertion order.
// All four delegate straight to the transfer-service API built in Tasks 1/4/5.
ipcMain.handle('transfer:pause', async (_e, jobId) => getTransferService().pause(jobId));
ipcMain.handle('transfer:resume', async (_e, jobId) => getTransferService().resume(jobId));
ipcMain.handle('transfer:reorder', async (_e, { jobId, dir }) => getTransferService().reorder(jobId, dir));
ipcMain.handle('transfer:queue-order', async () => getTransferService().queueOrder());
// RECEIVE path: the renderer's host-registration socket relays a TRANSFER_REQUEST
// here (a peer wants to push files at this machine). Fire-and-forget — startReceive
// only settles when the whole job does, so awaiting it would hang this call for the
// entire transfer; consent/progress flow via transfer:consent-request / transfer:event.
ipcMain.handle('transfer:incoming', async (_e, input) => {
  const sessionId = input && input.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return { error: 'invalid_request' };
  // SP3 Phase 4: the signaling server relays `linked` for an own-fleet transfer;
  // carry it through so the attacher enforces the device-keypair handshake.
  const linked = !!(input && input.linked);
  // Plan 3 Task 4 (SP3 multi-flow): groupId/flowIndex/flowCount identify which
  // multi-flow group (if any) this request belongs to — the signaling server
  // relays them verbatim on a real multi-flow CONNECT (Plan 2 Task 6); a
  // legacy/solo transfer sends none of these. Feed EVERY request (one per
  // flow) through the group-rendezvous coordinator instead of calling
  // startReceive directly — it folds a real group's N requests into ONE
  // receive/consent, and treats a legacy request as an immediate single-flow
  // group (see transfer-group-rendezvous.js), so this single call site now
  // covers both.
  const groupId = typeof (input && input.groupId) === 'string' ? input.groupId : undefined;
  const flowIndex = Number.isInteger(input && input.flowIndex) ? input.flowIndex : undefined;
  const flowCount = Number.isInteger(input && input.flowCount) ? input.flowCount : undefined;
  log?.child('transfer').info(`incoming transfer_request session=${sessionId}${linked ? ' linked' : ''}${groupId ? ` group=${groupId} flow=${flowIndex}/${flowCount}` : ''}`);
  groupRendezvous.offer({ sessionId, groupId, flowIndex, flowCount, linked });
  return { ok: true };
});

function configFilePath() {
  return path.join(app.getPath('userData'), 'config.json');
}
function readStoredConfig() {
  try { return parseConfig(readFileSync(configFilePath(), 'utf8')); }
  catch { return {}; }
}
ipcMain.handle('get-signaling-url', () => {
  const stored = readStoredConfig();
  return resolveSignalingUrl({
    envUrl: process.env.FARSIGHT_SIGNALING_URL,
    storedUrl: stored.signalingUrl,
  }).url;
});
ipcMain.handle('set-signaling-url', (_e, url) => {
  try {
    const normalized = validateSignalingUrl(url);
    // Merge onto the existing stored config — a bare { signalingUrl } write
    // here would CLOBBER controlAllowed (and any other persisted field).
    writeFileSync(configFilePath(), serializeConfig({ ...readStoredConfig(), signalingUrl: normalized }), { encoding: 'utf8', mode: 0o600 });
    return { ok: true, url: normalized };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Received-files folder: read the current resolved path, let the user pick a new
// one (persisted), or reset to the Downloads default. All writes MERGE onto the
// stored config (a bare write would clobber signalingUrl/controlAllowed).
ipcMain.handle('received-dir:get', () => receivedFilesDir());
ipcMain.handle('received-dir:choose', async () => {
  const r = await dialog.showOpenDialog(mainWindow || undefined, {
    title: 'Choose where received files are saved',
    defaultPath: receivedFilesDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, path: receivedFilesDir() };
  const chosen = r.filePaths[0];
  writeFileSync(configFilePath(), serializeConfig({ ...readStoredConfig(), receivedFilesDir: chosen }), { encoding: 'utf8', mode: 0o600 });
  return { ok: true, path: chosen };
});
ipcMain.handle('received-dir:reset', () => {
  const { receivedFilesDir: _drop, ...rest } = readStoredConfig();
  writeFileSync(configFilePath(), serializeConfig(rest), { encoding: 'utf8', mode: 0o600 });
  return { ok: true, path: receivedFilesDir() };
});

// "Allow this computer to be controlled" — persisted, receiver-side-enforced
// gate on inbound CONNECT (enforcement wiring lands in Task 6/7). Defaults to
// true — the maintainer's decision; the DEFAULT is what actually ships. The
// toggle is the mitigation for the posture change (every install is
// control-reachable); an owner turns it OFF on machines that must not be
// driven. Never trust a peer's flag — this machine decides from its own
// setting only, and fails closed on any read error.
function readControlAllowed() {
  const stored = readStoredConfig();
  return typeof stored.controlAllowed === 'boolean' ? stored.controlAllowed : true; // default when unset
}
function writeControlAllowed(allowed) {
  // Merge onto the existing stored config — see the set-signaling-url note above.
  writeFileSync(configFilePath(), serializeConfig({ ...readStoredConfig(), controlAllowed: !!allowed }), { encoding: 'utf8', mode: 0o600 });
  return { ok: true, controlAllowed: !!allowed };
}
ipcMain.handle('control-allowed:get', () => readControlAllowed());
ipcMain.handle('control-allowed:set', (_e, v) => writeControlAllowed(!!v));

// "Parallel connections" (Plan 3 Task 6) — how many parallel WebRTC flows a
// send opens, plumbed to the send's `flowCount` (see the transfer:send handler
// below). Default 8, clamped 1-32 by resolveParallelConnections (shared with
// config.js's parse/serialize so the clamp/default logic lives in ONE place).
// `flowCount === 1` reproduces the pre-Task-3 single-flow path exactly — the
// multi-flow branch in getTransferService()'s openChannel above only triggers
// when flowCount > 1.
// NOTE: each flow opens its own signaling CONNECT, drawing the server's per-IP
// `connectBurst` budget (default 30, never refunded on success — see
// @farsight/shared/config MAX_PARALLEL_CONNECTIONS). A configured value near the
// 32 ceiling can therefore exceed the connect budget and self-rate-limit; auto
// flow-scaling (Phase 2.4) caps to the budget.
function parallelConnections() {
  return resolveParallelConnections(readStoredConfig().parallelConnections);
}
ipcMain.handle('parallel-connections:get', () => parallelConnections());
ipcMain.handle('parallel-connections:set', (_e, v) => {
  const n = resolveParallelConnections(v);
  // Merge onto the existing stored config — see the set-signaling-url note above.
  writeFileSync(configFilePath(), serializeConfig({ ...readStoredConfig(), parallelConnections: n }), { encoding: 'utf8', mode: 0o600 });
  return { ok: true, parallelConnections: n };
});

// "Rate limit" (Plan 3 Task 7) — bandwidth ceiling in Mbps for a send's
// parallel flows; 0 = unlimited, else [1,1000] (resolveRateLimit, shared with
// config.js's parse/serialize so the clamp/default logic lives in ONE place —
// same pattern as parallelConnections above).
function rateLimit() {
  return resolveRateLimit(readStoredConfig().rateLimitMbps);
}
ipcMain.handle('rate-limit:get', () => rateLimit());
ipcMain.handle('rate-limit:set', (_e, v) => {
  const n = resolveRateLimit(v);
  // Merge onto the existing stored config — see the set-signaling-url note above.
  writeFileSync(configFilePath(), serializeConfig({ ...readStoredConfig(), rateLimitMbps: n }), { encoding: 'utf8', mode: 0o600 });
  // Apply live to the already-constructed service (Settings changes a
  // running app's limiter without recreating the service instance).
  getTransferService().setRateLimit(n);
  return { ok: true, rateLimitMbps: n };
});

// Provide the primary screen source id to the renderer on request.
ipcMain.handle('get-screen-source', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const primaryId = screen.getPrimaryDisplay().id;
    const src = sources.find((s) => String(s.display_id) === String(primaryId)) ?? sources[0];
    return src ? src.id : null;
  } catch (err) {
    log?.child('ipc').warn(`screen-source failed: ${err.message}`);
    return null;
  }
});

ipcMain.handle('get-screen-size', () => {
  const { width, height } = screen.getPrimaryDisplay().size;
  return { width, height };
});

// Enumerate all monitors so the renderer can offer a picker and capture a
// specific display.
ipcMain.handle('list-displays', () => listDisplays(screen));

// Resolve the desktopCapturer source id for a given display id (monitor switch).
ipcMain.handle('get-screen-source-for', async (_e, displayId) => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const s = sources.find((x) => String(x.display_id) === String(displayId));
    return s ? s.id : (sources[0] ? sources[0].id : null);
  } catch (err) {
    log?.child('ipc').warn(`screen-source failed: ${err.message}`);
    return null;
  }
});

// Point the main-process injector at the selected monitor's DIP bounds so
// input maps into that display's region.
ipcMain.handle('select-injector-display', (_e, index) => {
  const d = listDisplays(screen)[index];
  if (d) getInjector().setDisplay(d);
});

// Inject an input event received over the WebRTC data channel. Fire-and-forget
// (ipcRenderer.send) so high-frequency mouse moves don't await a round trip.
// The injector validates every event before it reaches nut.js.
ipcMain.on('inject-input', (_e, evt) => { getInjector().inject(evt); });

// Clipboard sync: the renderer polls/writes the OS clipboard via these handlers.
// Build version for the subtle bottom-left label; app.getVersion() reads the
// packaged package.json version (set from the git tag by the release CI).
ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('clipboard-read', () => clipboard.readText());
ipcMain.on('clipboard-write', (_e, text) => { if (typeof text === 'string' && text.length <= 100000) clipboard.writeText(text); });

// Unification step 2: the remote-control session now lives in its own
// BrowserWindow (session-window.js) instead of taking over the shell's main
// window. Created lazily on first session:open; its status/closed events are
// forwarded to the shell window so the shell can show a status bar. The
// factory itself registers the session:status/session:log ipcMain listeners
// (called back via onStatus/onLog below) — do NOT re-register those topics
// here, that would double-handle them.
let sessionWindow = null;
function getSessionWindow() {
  if (!sessionWindow) {
    sessionWindow = createSessionWindow({
      onStatus: (status) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('session:status', status); },
      onClosed: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('session:closed'); },
      onLog: (obj) => log?.child('session-window').info(JSON.stringify(obj)),
    });
  }
  return sessionWindow;
}
ipcMain.on('session:open', (_e, params) => getSessionWindow().launch(params));
ipcMain.on('session:focus', () => getSessionWindow().focus());

let mainWindow = null;
let tray = null;
// Centralizes the "is the app really quitting?" latch shared by the window
// close-guard and every quit path (tray Quit, auto-update install).
const lifecycle = createLifecycle();
let ctrlUpdater = null;
let lastHandledTarget = null; // S2.7: the last remote-update target we acted on
let latestUpdateUi = { showRestartPrompt: false, checking: false, message: '', version: null };
let log = null;   // root logger; assigned on app ready, referenced as log?.*
let logMinLevel = null; // createAppLogger's resolved level; used in diagnostics meta
let hostId = '';
// 16×16 Aurora gradient PNG (violet→blue, rounded). Inline data URL so the tray
// needs no external icon asset (packaging-safe).
const TRAY_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAmUlEQVR4nKXT4QrBYBiG4ef4RCKRLKyxsLCwsEitpKSkpKSkpJzlLXIE33sA189LKw+lLbT0Yd6BJIRZHyYRxCMYxzCcQpTAYAG9FMI1dDcoyJArJsjA3yILpr0DWXBzD7Jg7wCy4MYRZMH1E8iCa2eQBVcvIAuuXEEWXL6BLLh0B1lw8QGy4MIT9F/lhPMv9Cv5XeWCc2/0AR9g1yt6gn/UAAAAAElFTkSuQmCC';

// Per-launch session password. Generated in the trusted main process (node:crypto)
// and handed to the renderer via IPC — the sandboxed renderer can't run node:crypto.
let sessionPassword = generateSessionPassword();

// Input injection uses nut.js, a native Node addon that cannot load in the
// sandboxed renderer. The renderer forwards validated-shape input events over
// IPC; we validate (inside the injector) and inject here in the main process.
// The injector is display-aware: fractional [0,1] coords map into the selected
// display's DIP bounds, then through screen.dipToScreenPoint to physical pixels
// (correct on scaled/secondary monitors). It starts on the primary display and
// follows the controller's monitor selection via 'select-injector-display'.
let injector = null;
function getInjector() {
  if (!injector) {
    const displays = listDisplays(screen);
    const primary = displays.find((d) => d.primary) ?? displays[0];
    injector = createInjector({
      nut: createNutFacade({ log: log?.child('nut') }),
      display: primary,
      dipToScreen: (p) => screen.dipToScreenPoint(p),
      log: log?.child('injector'),
    });
  }
  return injector;
}

// Bring the window to attention when a controller (or a transfer offer) asks
// for it. The renderer forwards a control CONNECT via IPC 'request-attention';
// we apply the pure windowAttentionPlan. (Mirrors the host, minus its
// refreshTrayMenu() call — attention doesn't change any tray-displayed state.)
function bringWindowToAttention() {
  log?.child('session').info('attention requested by incoming connection');
  const win = mainWindow;
  if (!win) return;
  const plan = windowAttentionPlan({
    isMinimized: win.isMinimized(),
    isVisible: win.isVisible(),
    isFocused: win.isFocused(),
  });
  if (plan.show) win.show();
  if (plan.restore) win.restore();
  if (plan.raiseTemporarily) { win.setAlwaysOnTop(true); setTimeout(() => win.setAlwaysOnTop(false), 1500); }
  if (plan.focus) { win.moveTop(); win.focus(); }
  if (plan.flash) win.flashFrame(true);
}
ipcMain.on('request-attention', () => bringWindowToAttention());

// The renderer reports its registered id so the account service can publish
// the host's current signaling id (connect-from-console rendezvous), and so
// the tray can display it.
ipcMain.on('set-host-id', (_e, id) => { hostId = String(id || ''); getAccountService().setSignalingId(hostId); log?.child('session').info('host id registered'); refreshTrayMenu(); });

// The renderer displays the session password and sends it on REGISTER.
ipcMain.handle('get-session-password', () => sessionPassword);

// Rotate the session password on demand (renderer's manual button or idle
// timer). Regenerate in the trusted main process, refresh the tray label, and
// return the new value so the renderer can display it and push UPDATE_PASSWORD.
ipcMain.handle('regenerate-session-password', () => {
  sessionPassword = generateSessionPassword();
  refreshTrayMenu();
  return sessionPassword;
});

// Verbose diagnostic logging (§ SECURITY.md): consent-gated, account-authenticated
// upload of a redaction-safe log bundle for support triage.
async function sendDiagnostics() {
  const scope = log?.child('diagnostics');
  const svc = getAccountService();
  const status = await svc.status();
  if (!status.signedIn) return { ok: false, error: 'not_logged_in' };
  const { response } = await dialog.showMessageBox(mainWindow || undefined, {
    type: 'question',
    buttons: ['Send', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Send diagnostics to support',
    message: 'Upload your Farsight logs to support?',
    detail: 'Logs never contain your password, screen contents, or file contents.',
  });
  if (response !== 0) return { ok: false, error: 'cancelled' };
  const logsDir = path.join(app.getPath('userData'), 'logs');
  const meta = {
    app: 'controller',
    version: app.getVersion(),
    os: `${process.platform} ${os.release()}`,
    arch: process.arch,
    packaged: app.isPackaged,
    level: logMinLevel,
  };
  const { files } = buildDiagnosticsBundle({ logsDir, fs: nodeFs, meta });
  const res = await svc.uploadDiagnostics({ meta, files });
  scope?.info(`upload ${res.ok ? `ok id=${res.data?.id}` : `failed ${res.error || 'unknown'}`}`);
  return res.ok ? { ok: true, id: res.data?.id } : { ok: false, error: res.error };
}
ipcMain.handle('diagnostics:send', () => sendDiagnostics());

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate({
    id: hostId,
    password: sessionPassword,
    onShow: () => revealWindow(mainWindow),
    onQuit: () => { lifecycle.beginQuit(); app.quit(); },
    updateReady: latestUpdateUi.showRestartPrompt,
    updateVersion: latestUpdateUi.version,
    onRestartUpdate: () => ctrlUpdater && ctrlUpdater.installNow(),
    onCheckUpdates: () => ctrlUpdater && ctrlUpdater.checkNow(),
    onOpenLogs: () => shell.openPath(path.join(app.getPath('userData'), 'logs')),
    loggedIn: accountLoggedIn,
    onSendDiagnostics: async () => {
      const res = await sendDiagnostics();
      if (res.ok) {
        await dialog.showMessageBox(mainWindow || undefined, {
          type: 'info',
          title: 'Send diagnostics to support',
          message: `Diagnostics sent — reference ${res.id}`,
        });
      } else if (res.error === 'cancelled') {
        // user declined the consent prompt inside sendDiagnostics(); no further dialog
      } else if (res.error === 'not_logged_in') {
        await dialog.showMessageBox(mainWindow || undefined, {
          type: 'error',
          title: 'Send diagnostics to support',
          message: 'Sign in to send diagnostics',
        });
      } else {
        await dialog.showMessageBox(mainWindow || undefined, {
          type: 'error',
          title: 'Send diagnostics to support',
          message: `Diagnostics upload failed: ${res.error}`,
        });
      }
    },
  })));
}

function createTray() {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  tray = new Tray(icon);
  tray.setToolTip('Farsight');
  tray.on('click', () => revealWindow(mainWindow));
  refreshTrayMenu();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // R-7: defense in depth
      // Mirrors the host (see its main.js for the measured numbers and the real
      // mechanism: a background renderer drops to Idle process priority and
      // starves under CPU contention). This renderer owns input capture and the
      // peer connection, so a covered/minimized controller would degrade the
      // session it is driving. Cheap — an idle renderer schedules no work, so
      // the flag costs ~0.01% CPU; what it buys is Normal priority.
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) e.preventDefault(); });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Attended-access: the app must keep running to receive connections, so
  // closing the window hides it to the tray instead of quitting. A real quit
  // (from any path) latches lifecycle.beginQuit() via app 'before-quit' first,
  // so shouldHideOnClose() returns false and the window is allowed to close —
  // which then lets 'window-all-closed' fire and take the session + transfer
  // worker windows down with app.quit() (see that handler below).
  win.on('close', (e) => {
    if (lifecycle.shouldHideOnClose()) { e.preventDefault(); win.hide(); }
  });
  mainWindow = win;
  return win;
}

// Single-instance lock (BUG 2, field-diagnosed): the controller had no lock at
// all, so relaunching it ran a SECOND process beside a still-running first one
// — a real controller log showed the OLD process's [ft-worker] heartbeat still
// beating 24s after the NEW process logged "controller starting", with the new
// instance showing its own empty Transfers list. Two instances sharing one
// jobs-store also makes the startup stale-send sweep below unsafe: a second
// instance could rewrite the FIRST instance's genuinely-live 'active' send
// record to 'interrupted' out from under it, and the resume watcher would then
// try to re-establish a job that is still actively sending. Mirrors the host's
// lock (packages/host/src/main.js) — first instance wins; a later launch hands
// off via 'second-instance' to reveal the running window, then exits.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();
// Now that the window hides to the tray on close instead of being destroyed,
// it is never gone while the app is running — a plain reveal (mirrors the
// host) is always correct; the old recreate-if-destroyed fallback no longer
// applies.
app.on('second-instance', () => revealWindow(mainWindow));
// Any genuine quit — tray "Quit", autoUpdater.quitAndInstall(), or the
// autoInstallOnAppQuit fallback — routes through app 'before-quit', which
// latches quitting BEFORE the window gets its 'close' event. Without this the
// close-guard preventDefaults the quit, the process stays alive, and the update
// installer can't shut the running app down.
app.on('before-quit', () => lifecycle.beginQuit());

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;   // losing instance: never create a window
  // No native application menu bar (File/Edit/View/Window/Help). This is a
  // tray-first consumer app with its own in-window chrome; the default menu adds
  // nothing and its Alt-key strip clutters the window. Removes it from every
  // BrowserWindow on Windows/Linux.
  Menu.setApplicationMenu(null);
  ({ log, minLevel: logMinLevel } = createAppLogger({
    filePath: path.join(app.getPath('userData'), 'logs', 'main.log'),
    fs: nodeFs,
    dirname: path.dirname,
    isPackaged: app.isPackaged,
    env: process.env,
    mirror: app.isPackaged ? null : (line) => console.log(line),
  }));
  log.info('controller starting');

  process.on('uncaughtException', (err) => log?.error(`uncaughtException: ${err?.stack || err}`));
  process.on('unhandledRejection', (reason) => log?.error(`unhandledRejection: ${reason?.stack || reason}`));
  app.on('render-process-gone', (_e, _wc, d) => log?.error(`render-process-gone: ${d?.reason}`));
  app.on('child-process-gone', (_e, d) => log?.error(`child-process-gone: ${d?.type} ${d?.reason}`));

  ipcMain.on('log:renderer', (_e, entry) => {
    const level = ['debug', 'info', 'warn', 'error'].includes(entry?.level) ? entry.level : 'error';
    const scope = typeof entry?.scope === 'string' && entry.scope ? `renderer:${entry.scope}` : 'renderer';
    log?.child(scope)[level](String(entry?.msg ?? ''));
  });

  createWindow();
  createTray();
  mainWindow.on('focus', () => mainWindow.flashFrame(false));
  // Panic hotkey: a physical override that instantly kills any session.
  // globalShortcut.register fails silently if another app already owns the
  // accelerator, leaving the documented instant-kill override inactive — warn
  // in the console and surface it visibly in the renderer. did-finish-load is
  // attached synchronously here (before the async loadFile navigation
  // triggered in createWindow can complete), so it cannot fire before this
  // listener is registered; the renderer's own onPanicUnavailable listener is
  // wired up before its first await, so it is guaranteed to be registered by
  // the time did-finish-load fires.
  const panicOk = registerPanicKey(globalShortcut, 'CommandOrControl+Alt+F12', () => {
    log?.child('session').warn('panic hotkey fired — killing session');
    if (mainWindow) mainWindow.webContents.send('panic');
  });
  if (!panicOk) {
    console.warn('[panic] Failed to register Ctrl+Alt+F12 — another app may own it. The instant-kill override is NOT active.');
    log?.child('session').warn('panic hotkey unavailable — another app owns Ctrl+Alt+F12');
    mainWindow.webContents.on('did-finish-load', () => {
      if (mainWindow) mainWindow.webContents.send('panic-unavailable');
    });
  }
  // BUG 1 (field-diagnosed): a dir:'send' record still saying 'active' at
  // process START is impossible-by-definition — the process that owned it is
  // gone (this app just launched). Sweep those to 'interrupted' (fleet/contact,
  // resumable) or 'error' (adhoc, nothing will ever resume it) BEFORE the resume
  // watcher starts, so its first sweep actually sees the swept records — this
  // is the single-instance lock above's real payoff (a second instance sweeping
  // concurrently could stomp a genuinely-live 'active' record).
  try { await getTransferService().recoverStaleJobs(); } catch (e) { log?.child('transfer').warn(`stale-job sweep failed: ${e?.message || e}`); }
  // SP3 Phase 4 auto-resume: start the resume watcher on launch so an own-fleet
  // send interrupted in a PREVIOUS run resumes once its device is online again
  // (across-restart). Idle/no-op until signed in and an interrupted job exists.
  try { getTransferService().startResumeWatcher(); } catch (e) { log?.child('transfer').warn(`resume watcher start failed: ${e?.message || e}`); }
  autoUpdater.logger = {
    info: (m) => log?.child('updater').info(String(m)),
    warn: (m) => log?.child('updater').warn(String(m)),
    error: (m) => log?.child('updater').error(String(m)),
    debug: (m) => log?.child('updater').debug(String(m)),
  };
  ctrlUpdater = createUpdater({
    updater: autoUpdater,
    isPackaged: app.isPackaged,
    log: (level, msg) => { const l = log?.child('updater'); if (l && l[level]) l[level](msg); },
    onStatus: (ui) => {
      latestUpdateUi = ui;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updater:status', ui);
      refreshTrayMenu();
    },
  });
  ctrlUpdater.start();

  // Remote update (S2.7): act on a converge-to directive delivered via the account
  // heartbeat. Only when the target is strictly newer than us, and only once per
  // target. FORCED: the owner explicitly pressed Update, so it installs even during
  // a live session (theirs, almost always) and silently — a remote host has nobody
  // at the screen. It always relaunches, so the host is back in seconds. A
  // background/automatic update still waits for the session to end.
  // Installs ONLY the official feed release; the directive is just a version string.
  // (This wiring was dropped in the v2.0 unification — remote update broke at 2.0.0
  //  until it was ported back; guarded by test/updater-wiring.test.js.)
  getAccountService().onUpdateDirective((data) => {
    const target = data && typeof data.targetVersion === 'string' ? data.targetVersion : null;
    if (target && target !== lastHandledTarget && shouldConverge({ currentVersion: app.getVersion(), targetVersion: target })) {
      lastHandledTarget = target;
      log?.child('updater').info(`remote update directive → converge to ${target} (forced)`);
      if (ctrlUpdater) ctrlUpdater.installWhenReady({ force: true });
    }
  });

  ipcMain.handle('updater:check', () => { ctrlUpdater.checkNow(); return true; });
  ipcMain.handle('updater:install', () => ctrlUpdater.installNow());
  ipcMain.on('updater:set-session-active', (_e, active) => ctrlUpdater.setSessionActive(active));
  ipcMain.handle('open-logs', () => shell.openPath(path.join(app.getPath('userData'), 'logs')));
});
app.on('will-quit', () => { log?.info('controller quitting'); globalShortcut.unregisterAll(); });
// The main window only HIDES on close while running (see the close-guard
// above), so this does not fire mid-session/mid-transfer — correct, the app
// must keep running in the tray. On a real quit, before-quit has already
// latched lifecycle.beginQuit(), the close-guard lets the window close, and
// THIS event fires and takes the session + transfer worker windows down too.
app.on('window-all-closed', () => { if (lifecycle.isQuitting() && process.platform !== 'darwin') app.quit(); });
