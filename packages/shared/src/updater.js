// Runtime-agnostic orchestrator around an injected electron-updater-shaped
// `updater`. Holds status/session/downloaded state, delegates all decisions to
// update-policy, and reports UI state via onStatus. No electron / electron-updater
// import here — the app passes autoUpdater in — so this is unit-testable.
import { updateUiState, canInstallNow } from './update-policy.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export function createUpdater({ updater, isPackaged, onStatus, intervalMs = SIX_HOURS_MS }) {
  let status = 'idle';
  let version = null;
  let downloaded = false;
  let sessionActive = false;

  const emit = () => onStatus(updateUiState({ status, sessionActive, version }));
  const check = () => {
    updater.checkForUpdates().catch(() => { status = 'error'; emit(); });
  };

  return {
    start() {
      if (!isPackaged) return;                 // inert in dev / unpackaged
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = true;     // lazy fallback: applies on natural quit
      updater.on('checking-for-update', () => { status = 'checking'; emit(); });
      updater.on('update-available', (info) => { status = 'available'; version = info?.version ?? version; emit(); });
      updater.on('update-not-available', () => { status = 'idle'; emit(); });
      updater.on('download-progress', () => { status = 'downloading'; emit(); });
      updater.on('update-downloaded', (info) => { status = 'downloaded'; downloaded = true; version = info?.version ?? version; emit(); });
      updater.on('error', () => { status = 'error'; emit(); });
      check();
      setInterval(check, intervalMs);
    },
    checkNow() { if (isPackaged) check(); },
    setSessionActive(active) { sessionActive = !!active; emit(); },
    installNow() {
      if (canInstallNow({ downloaded, sessionActive })) { updater.quitAndInstall(); return { ok: true }; }
      return { ok: false, reason: sessionActive ? 'session-active' : 'not-downloaded' };
    },
  };
}
