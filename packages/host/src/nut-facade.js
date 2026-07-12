// packages/host/src/nut-facade.js
// Runs in the MAIN process only — nut.js is a native Node addon and cannot load
// in the sandboxed renderer. The renderer forwards validated input events over
// IPC; main injects them through this facade.
import { mouse, keyboard, Button, Key, Point } from '@nut-tree-fork/nut-js';

const BUTTON_MAP = { left: Button.LEFT, right: Button.RIGHT, middle: Button.MIDDLE };

// Map our key strings to nut Key enum. Printable single chars are typed directly.
const KEY_MAP = {
  Enter: Key.Enter, Backspace: Key.Backspace, Tab: Key.Tab, Escape: Key.Escape,
  Delete: Key.Delete, ArrowUp: Key.Up, ArrowDown: Key.Down, ArrowLeft: Key.Left,
  ArrowRight: Key.Right, Home: Key.Home, End: Key.End, PageUp: Key.PageUp,
  PageDown: Key.PageDown, ' ': Key.Space, Shift: Key.LeftShift, Control: Key.LeftControl,
  Alt: Key.LeftAlt, Meta: Key.LeftSuper, CapsLock: Key.CapsLock,
  F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6,
  F7: Key.F7, F8: Key.F8, F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12,
};

export function createNutFacade() {
  mouse.config.autoDelayMs = 0; // low latency
  return {
    async moveMouse(x, y) { await mouse.setPosition(new Point(x, y)); },
    async mouseDown(button) { await mouse.pressButton(BUTTON_MAP[button]); },
    async mouseUp(button) { await mouse.releaseButton(BUTTON_MAP[button]); },
    async scroll(dx, dy) { if (dy) await mouse.scrollDown(dy); if (dx) await mouse.scrollRight(dx); },
    async keyDown(key) { const k = KEY_MAP[key]; if (k !== undefined) await keyboard.pressKey(k); else await keyboard.type(key); },
    async keyUp(key) { const k = KEY_MAP[key]; if (k !== undefined) await keyboard.releaseKey(k); },
  };
}
