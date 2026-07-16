// packages/controller/src/main.js
import { app, BrowserWindow, ipcMain, clipboard, dialog, shell, safeStorage } from 'electron';
// electron-updater is CommonJS: a named ESM import fails in the packaged app's
// ESM loader, so use the default import + destructure interop.
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { createAppLogger } from '@farsight/shared/app-log';
import { parseConfig, serializeConfig, validateSignalingUrl, resolveSignalingUrl } from '@farsight/shared/config';
import { createUpdater } from '@farsight/shared/updater';
import { createAccountService, DEFAULT_ACCOUNT_URL } from './account.js';
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
ipcMain.handle('account:status', () => getAccountService().status());
ipcMain.handle('account:login', (_e, input) => getAccountService().login(input));
ipcMain.handle('account:logout', () => getAccountService().logout());
ipcMain.handle('account:register', (_e, input) => getAccountService().register(input));
ipcMain.handle('account:resend-verification', (_e, input) => getAccountService().resendVerification(input));
ipcMain.handle('account:request-password-reset', (_e, input) => getAccountService().requestPasswordReset(input));
ipcMain.handle('account:fleet', () => getAccountService().fleet());
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
      openChannel: async ({ role, target, sessionId }) => {
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
            version: app.getVersion(),
          });
        } else {
          worker.startRendezvous({ role: 'attach', signalingUrl, sessionId, version: app.getVersion() });
        }
        return {
          channel: worker.channel,
          close: async () => worker.close(),
          onRendezvousError: (cb) => { rendezvousErrorCb = cb; },
        };
      },
      onEvent: (ev) => {
        const prog = ev.progress ? ` files=${ev.progress.filesSent ?? ev.progress.filesDone}/${ev.progress.filesTotal}` : '';
        log?.child('transfer').info(`send ev=${ev.type || 'progress'} job=${ev.jobId}${prog}${ev.reason ? ` reason=${ev.reason}` : ''}`);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('transfer:event', ev);
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
    getTransferService().startSend({ jobId, manifest, sources, target })
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
    writeFileSync(configFilePath(), serializeConfig({ signalingUrl: normalized }), { encoding: 'utf8', mode: 0o600 });
    return { ok: true, url: normalized };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Clipboard sync: the renderer polls/writes the OS clipboard via these handlers.
// Build version for the subtle bottom-left label; app.getVersion() reads the
// packaged package.json version (set from the git tag by the release CI).
ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('clipboard-read', () => clipboard.readText());
ipcMain.on('clipboard-write', (_e, text) => { if (typeof text === 'string' && text.length <= 100000) clipboard.writeText(text); });

let mainWindow = null;
let ctrlUpdater = null;
let log = null;   // root logger; assigned on app ready, referenced as log?.*
let logMinLevel = null; // createAppLogger's resolved level; used in diagnostics meta

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

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // R-7: defense in depth
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) e.preventDefault(); });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow = win;
  return win;
}
app.whenReady().then(() => {
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
    onStatus: (ui) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updater:status', ui); },
  });
  ctrlUpdater.start();
  ipcMain.handle('updater:check', () => { ctrlUpdater.checkNow(); return true; });
  ipcMain.handle('updater:install', () => ctrlUpdater.installNow());
  ipcMain.on('updater:set-session-active', (_e, active) => ctrlUpdater.setSessionActive(active));
  ipcMain.handle('open-logs', () => shell.openPath(path.join(app.getPath('userData'), 'logs')));
});
app.on('window-all-closed', () => { log?.info('controller quitting'); if (process.platform !== 'darwin') app.quit(); });
