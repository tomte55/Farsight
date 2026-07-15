// Runtime-agnostic orchestrator around an injected electron-updater-shaped
// `updater`. Holds status/session/downloaded state, delegates all decisions to
// update-policy, and reports UI state via onStatus. No electron / electron-updater
// import here — the app passes autoUpdater in — so this is unit-testable.
import { updateUiState, canInstallNow } from './update-policy.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

const errText = (e) => (e && e.message) ? e.message : String(e);

export function createUpdater({ updater, isPackaged, onStatus, log = () => {}, intervalMs = SIX_HOURS_MS }) {
  let status = 'idle';
  let version = null;
  let downloaded = false;
  let sessionActive = false;
  // Remote update (S2.7): when set, install as soon as the download is ready and
  // no session is active (deferring across an active session).
  let installWhenDownloaded = false;

  const emit = () => onStatus(updateUiState({ status, sessionActive, version, downloaded }));
  // The guarded install: only quitAndInstall when downloaded AND no active session.
  const tryInstall = () => {
    if (canInstallNow({ downloaded, sessionActive })) { updater.quitAndInstall(); return { ok: true }; }
    return { ok: false, reason: sessionActive ? 'session-active' : 'not-downloaded' };
  };
  const check = () => {
    try {
      updater.checkForUpdates().catch((err) => {
        status = 'check-error';
        log('error', `check failed: ${errText(err)}`);
        emit();
      });
    } catch (err) {
      status = 'check-error';
      log('error', `check threw: ${errText(err)}`);
      emit();
    }
  };

  return {
    start() {
      if (!isPackaged) return;                 // inert in dev / unpackaged
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = true;     // lazy fallback: applies on natural quit
      updater.on('checking-for-update', () => { status = 'checking'; log('info', 'checking for update'); emit(); });
      updater.on('update-available', (info) => { status = 'available'; version = info?.version ?? version; log('info', `update available: ${version}`); emit(); });
      updater.on('update-not-available', () => { status = 'idle'; log('info', 'no update available (up to date)'); emit(); });
      updater.on('download-progress', () => { if (status !== 'downloading') log('info', 'downloading update'); status = 'downloading'; emit(); });
      updater.on('update-downloaded', (info) => { status = 'downloaded'; downloaded = true; version = info?.version ?? version; log('info', `update downloaded: ${version}`); if (installWhenDownloaded) tryInstall(); emit(); });
      // The electron-updater 'error' event covers BOTH check and download
      // failures. Classify by the phase we were in: if we'd already found an
      // update (available/downloading), the download broke; otherwise the check
      // itself broke. This drives the distinct user-facing messages.
      updater.on('error', (err) => {
        const duringDownload = status === 'available' || status === 'downloading';
        status = duringDownload ? 'download-error' : 'check-error';
        log('error', `${status}: ${errText(err)}`);
        emit();
      });
      check();
      setInterval(check, intervalMs);
    },
    checkNow() { if (isPackaged) check(); },
    setSessionActive(active) {
      sessionActive = !!active;
      // If a remote update was pending and deferred for a live session, apply it
      // the moment the session ends.
      if (!sessionActive && installWhenDownloaded && downloaded) tryInstall();
      emit();
    },
    installNow() { return tryInstall(); },
    // Remote update (S2.7): converge now — install if already downloaded (deferring
    // if a session is active), else trigger a check/download and install on ready.
    installWhenReady() {
      if (!isPackaged) return { ok: false, reason: 'not-packaged' };
      installWhenDownloaded = true;
      if (downloaded) return tryInstall();
      check(); // autoDownload is on → 'update-downloaded' will fire tryInstall
      return { ok: true, pending: true };
    },
  };
}
