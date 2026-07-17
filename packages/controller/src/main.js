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
import { parseConfig, serializeConfig, validateSignalingUrl, resolveSignalingUrl } from '@farsight/shared/config';
import { createUpdater } from '@farsight/shared/updater';
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
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  const res = await getAccountService().login(input);
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

// SP3 file transfer (send path). Each transfer gets its own createTransferWorker()
// — a hidden BrowserWindow owning a DEDICATED RTCPeerConnection + signaling
// socket (see transfer-worker.js), independent of the main control session's
// peer. The jobs-store persists progress under userData/transfers so a send
// survives across app restarts (resume is a later phase — this wiring covers
// starting a fresh send end to end). `consent` always declines because the
// controller UI does not offer a receive flow yet (Phase 2 follow-up); nothing
// currently calls startReceive from this app.
let jobsStore = null;
function getJobsStore() {
  if (!jobsStore) jobsStore = createJobsStore({ dir: path.join(app.getPath('userData'), 'transfers') });
  return jobsStore;
}
let transferService = null;
function getTransferService() {
  if (!transferService) {
    transferService = createTransferService({
      store: getJobsStore(),
      transferDir: path.join(app.getPath('userData'), 'transfers-received'),
      consent: async () => false, // receive UI not wired yet — see comment above
      // Canonical rendezvous shape (SP3 coherence contract #1), identical to
      // the host's openChannel: transfer-service always calls this as
      // { role, target, sessionId } — 'initiate' carries target (sessionId
      // undefined), 'attach' carries sessionId (target undefined).
      openChannel: async ({ role, target, sessionId, linked }) => {
        const worker = createTransferWorker({ onLog: (obj) => log?.child('ft-worker').info(JSON.stringify(obj)) });
        const stored = readStoredConfig();
        const signalingUrl = resolveSignalingUrl({
          envUrl: process.env.FARSIGHT_SIGNALING_URL,
          storedUrl: stored.signalingUrl,
        }).url;
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
        if (role === 'initiate') {
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
        } else {
          worker.startRendezvous({ role: 'attach', signalingUrl, sessionId, linked: !!linked, version: app.getVersion() });
        }
        return {
          channel: worker.channel,
          close: async () => worker.close(),
          onRendezvousError: (cb) => { rendezvousErrorCb = cb; },
        };
      },
      onEvent: (ev) => {
        const prog = ev.progress ? ` files=${ev.progress.filesSent ?? ev.progress.filesDone}/${ev.progress.filesTotal}` : '';
        // 'progress' fires ~4x/second on a long transfer — logging it at info
        // floods the rotating sink (2MB x 2 files) and evicts the [ft-worker]
        // counters field diagnostics depend on. Verbose connection detail is
        // debug-level (CLAUDE.md); every other (rarer) lifecycle event stays info.
        const level = ev.type === 'progress' ? 'debug' : 'info';
        log?.child('transfer')[level](`send ev=${ev.type} job=${ev.jobId}${prog}${ev.reason ? ` reason=${ev.reason}` : ''}`);
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
    log?.child('transfer').info(`send start job=${jobId} target=${target.id} files=${manifest.totalFiles} bytes=${manifest.totalBytes}`);
    // Fire-and-forget: startSend()'s promise only resolves once the WHOLE
    // transfer finishes, so awaiting it here would block the renderer's
    // transferSend() call for the entire transfer. Progress is instead
    // delivered incrementally via the 'transfer:event' push above.
    // `sourceRoots: paths` is persisted so an interrupted own-fleet send can be
    // re-walked and auto-resumed after an app restart (SP3 Phase 4).
    getTransferService().startSend({ jobId, manifest, sources, target, sourceRoots: paths })
      .catch((err) => log?.child('transfer').warn(`send failed: ${err?.message || err}`));
    return { jobId, manifest };
  } catch (err) {
    log?.child('transfer').warn(`transfer:send setup failed: ${err.message}`);
    return { error: err.message };
  }
});

ipcMain.handle('transfer:list', () => getTransferService().listJobs());

// SP3 coherence contract #3: cancel() now actually aborts an in-flight send —
// transfer-service.cancel() tears down the active job's channel (via the
// close() returned by openChannel above) in addition to marking the
// persisted job record canceled; a waiting (not-yet-active) job is just
// dropped from the queue.
ipcMain.handle('transfer:cancel', async (_e, jobId) => getTransferService().cancel(jobId));

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
  try { await getTransferService().recoverStaleSends(); } catch (e) { log?.child('transfer').warn(`stale-send sweep failed: ${e?.message || e}`); }
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
