// Runtime-agnostic decision logic for auto-update. No node:*, no Electron, no
// electron-updater — the main process injects the updater. This is the tested
// truth table; the orchestrator (updater.js) and app glue stay thin.
import { isOlder } from './version.js';

export const UPDATE_STATUS = {
  IDLE: 'idle',
  CHECKING: 'checking',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  DOWNLOADED: 'downloaded',
  // Two distinct failure modes — the electron-updater 'error' event fires for
  // both, but they mean very different things to the user: CHECK_ERROR = we
  // couldn't even reach/parse the update feed; DOWNLOAD_ERROR = we DID find an
  // update, but fetching the installer failed (e.g. a 404 on the asset).
  CHECK_ERROR: 'check-error',
  DOWNLOAD_ERROR: 'download-error',
};

// Given the updater status + whether a session is active, decide what the UI
// should show. A restart is only ever offered when an update is fully
// downloaded AND no session is active.
export function updateUiState({ status, sessionActive, version, downloaded } = {}) {
  const v = version ?? null;
  const ready = downloaded === true;            // sticky latch, survives a background re-check
  const showRestartPrompt = ready && !sessionActive;
  let message;
  if (ready) {
    message = sessionActive
      ? `Update ${v} will install after this session.`
      : `Update ${v} ready to install.`;
  } else {
    switch (status) {
      case 'checking': message = 'Checking for updates…'; break;
      case 'downloading': message = 'Downloading update…'; break;
      case 'available': message = `Update ${v} available…`; break;
      case 'download-error':
        // The check worked — an update exists — but we couldn't fetch it.
        message = v ? `Update ${v} was found, but the download failed.` : 'An update was found, but the download failed.';
        break;
      case 'check-error': message = "Couldn't check for updates."; break;
      case 'error': message = "Couldn't check for updates."; break;   // generic fallback
      default: message = 'Up to date.';
    }
  }
  return { showRestartPrompt, checking: status === 'checking', message, version: v };
}

// The gate the main process must pass before calling quitAndInstall().
export function canInstallNow({ downloaded, sessionActive } = {}) {
  return downloaded === true && sessionActive === false;
}

// Remote update (S2.7): should a host with `currentVersion` act on a converge-to
// `targetVersion` directive? Only when the target is a non-empty version STRING
// strictly newer than the current version — so an equal/older/absent target is a
// no-op (idempotent; once converged the host does nothing).
export function shouldConverge({ currentVersion, targetVersion } = {}) {
  if (typeof targetVersion !== 'string' || targetVersion.length === 0) return false;
  if (typeof currentVersion !== 'string' || currentVersion.length === 0) return false;
  return isOlder(currentVersion, targetVersion);
}
