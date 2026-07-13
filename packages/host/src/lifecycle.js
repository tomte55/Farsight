// packages/host/src/lifecycle.js
// Single source of truth for "is the app really quitting?". The host window hides
// to the tray on close (attended-access: it must keep running to accept
// connections), so the close-guard needs to distinguish a user closing the window
// (hide) from a genuine quit (let it close). main.js wires beginQuit() to app
// 'before-quit', so EVERY quit path — tray "Quit", autoUpdater.quitAndInstall(),
// and autoInstallOnAppQuit — latches the flag before windows get their 'close'
// event. Kept pure so the latch is unit-tested without the Electron lifecycle.
export function createLifecycle() {
  let quitting = false;
  return {
    isQuitting: () => quitting,
    beginQuit() { quitting = true; },
    // The window 'close' handler consults this: hide-to-tray while running,
    // allow the close through once a real quit is under way.
    shouldHideOnClose() { return !quitting; },
  };
}
