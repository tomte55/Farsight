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
  // Remote update (S2.7): the pending install came from an explicit owner request,
  // so it overrides the session guard and installs silently. Sticky — it must
  // survive the wait for the download to finish.
  let pendingForce = false;

  const emit = () => onStatus(updateUiState({ status, sessionActive, version, downloaded }));
  // The guarded install. Two independent concerns, decoupled on purpose:
  //  - overrideSession: an explicit human/owner "install now" wins over the
  //    "don't interrupt a live session" guard (they asked for it — and when the
  //    host is being remote-controlled, the clicking human IS the session).
  //  - silent: whether to show the visible installer UI. Only the remote/
  //    unattended path (nobody at the host's screen) is silent; a tray click
  //    from a human at the console (local OR remote-driving) keeps it visible.
  // A download is always required regardless of either flag.
  const tryInstall = ({ overrideSession = false, silent = false } = {}) => {
    if (canInstallNow({ downloaded, sessionActive, force: overrideSession })) {
      // Silent: relaunch too. Both args are load-bearing — electron-updater
      // only honours autoRunAppAfterInstall when isSilent is false, so
      // quitAndInstall(true) alone installs and NEVER comes back.
      if (silent) updater.quitAndInstall(true, true);
      // Visible: relaunch via autoRunAppAfterInstall (default true).
      else updater.quitAndInstall();
      return { ok: true };
    }
    return { ok: false, reason: (sessionActive && overrideSession !== true) ? 'session-active' : 'not-downloaded' };
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
      updater.on('update-downloaded', (info) => { status = 'downloaded'; downloaded = true; version = info?.version ?? version; log('info', `update downloaded: ${version}`); if (installWhenDownloaded) tryInstall({ overrideSession: pendingForce, silent: pendingForce }); emit(); });
      // The electron-updater 'error' event covers BOTH check and download
      // failures. Classify by the phase we were in: if we'd already found an
      // update (available/downloading), the download broke; otherwise the check
      // itself broke. This drives the distinct user-facing messages.
      updater.on('error', (err) => {
        const duringDownload = status === 'available' || status === 'downloading';
        status = duringDownload ? 'download-error' : 'check-error';
        // A forced install (S2.7) means "install what I asked for, right now".
        // If that attempt's check/download just failed, the intent is stale —
        // clear it so a LATER background download (found on some future 6-hour
        // check) installs politely (deferring across a live session) instead of
        // inheriting a stickiness that would kill an unrelated session days
        // later. installWhenDownloaded stays set: the owner's update still
        // lands, just without the force.
        pendingForce = false;
        log('error', `${status}: ${errText(err)}`);
        emit();
      });
      check();
      setInterval(check, intervalMs);
    },
    checkNow() { if (isPackaged) check(); },
    setSessionActive(active) {
      sessionActive = !!active;
      // If an update was pending and deferred for a live session, apply it the
      // moment the session ends.
      if (!sessionActive && installWhenDownloaded && downloaded) tryInstall({ overrideSession: pendingForce, silent: pendingForce });
      emit();
    },
    // Tray "Restart to update": an explicit human ask. Overrides the session
    // guard (see tryInstall above) but stays VISIBLE — someone is at a screen,
    // local or remote-driving, and the progress window is reassuring, not a
    // silent surprise reboot.
    installNow() { return tryInstall({ overrideSession: true, silent: false }); },
    // Remote update (S2.7): converge now — install if already downloaded, else
    // trigger a check/download and install on ready. `force` (an explicit remote
    // Update from the owner) installs even during a live session, silently —
    // nobody is at the remote host's screen to see the installer.
    installWhenReady({ force = false } = {}) {
      if (!isPackaged) return { ok: false, reason: 'not-packaged' };
      installWhenDownloaded = true;
      pendingForce = pendingForce || !!force; // sticky across the wait for the download
      if (downloaded) return tryInstall({ overrideSession: pendingForce, silent: pendingForce });
      check(); // autoDownload is on → 'update-downloaded' will fire tryInstall
      return { ok: true, pending: true };
    },
  };
}
