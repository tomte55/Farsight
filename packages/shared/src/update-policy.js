// Runtime-agnostic decision logic for auto-update. No node:*, no Electron, no
// electron-updater — the main process injects the updater. This is the tested
// truth table; the orchestrator (updater.js) and app glue stay thin.

export const UPDATE_STATUS = {
  IDLE: 'idle',
  CHECKING: 'checking',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  DOWNLOADED: 'downloaded',
  ERROR: 'error',
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
      case 'error': message = "Couldn't check for updates."; break;
      default: message = 'Up to date.';
    }
  }
  return { showRestartPrompt, checking: status === 'checking', message, version: v };
}

// The gate the main process must pass before calling quitAndInstall().
export function canInstallNow({ downloaded, sessionActive } = {}) {
  return downloaded === true && sessionActive === false;
}
