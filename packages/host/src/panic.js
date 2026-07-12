// packages/host/src/panic.js
export function registerPanicKey(globalShortcut, accelerator, onPanic) {
  const ok = globalShortcut.register(accelerator, onPanic);
  return Boolean(ok) && globalShortcut.isRegistered(accelerator);
}
