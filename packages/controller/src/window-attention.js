// packages/controller/src/window-attention.js
// Pure decision for how the host window should grab attention when a controller
// asks to connect. The main process reads the window's current state and applies
// the returned plan (show/restore/focus/flashFrame/alwaysOnTop). Kept pure so the
// branching is unit-tested without a real BrowserWindow.
export function windowAttentionPlan({ isMinimized, isVisible, isFocused }) {
  return {
    show: !isVisible,
    restore: isMinimized,
    focus: true,
    flash: !isFocused,
    raiseTemporarily: !isFocused,
  };
}
