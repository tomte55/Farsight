// packages/controller/src/nut-facade.js
// Runs in the MAIN process only — nut.js is a native Node addon and cannot load
// in the sandboxed renderer. The renderer forwards validated input events over
// IPC; main injects them through this facade.
// Verbose diagnostic logging (see docs/private/superpowers): the failed op name
// + error message only — never coords/keys/clipboard text.
import { mouse, keyboard, Button, Key, Point } from '@nut-tree-fork/nut-js';

function noopLog() { const n = { debug() {}, info() {}, warn() {}, error() {}, child: () => n }; return n; }

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

export function createNutFacade({ log = noopLog() } = {}) {
  // Both auto-delays MUST be zeroed. nut.js defaults keyboard.autoDelayMs to 300 and
  // awaits sleep(autoDelayMs) BEFORE every pressKey/releaseKey and every char of type()
  // — 300ms per printable char, 600ms per mapped key's down/up pair. The injector
  // serializes all events through one promise chain, so under sustained typing those
  // sleeps compound into an ever-growing backlog rather than a fixed lag. The mouse
  // never showed this (MouseClass hardcodes setMouseDelay(0); setPosition never sleeps),
  // which is why the symptom was "typing lags, mouse is snappy".
  // Pinned by test/nut-facade.test.js.
  mouse.config.autoDelayMs = 0; // low latency
  keyboard.config.autoDelayMs = 0; // low latency
  // Wraps a native op so a failure is logged (message only) and re-thrown — the
  // injector's own enqueue chain also logs an 'injection failed' breadcrumb at
  // its scope, so the failure is visible from both the 'nut' and 'injector' logs.
  const guard = (op, fn) => async (...args) => {
    try { return await fn(...args); } catch (e) { log.error(`nut ${op} failed: ${e?.message ?? e}`); throw e; }
  };
  return {
    moveMouse: guard('moveMouse', async (x, y) => { await mouse.setPosition(new Point(x, y)); }),
    mouseDown: guard('mouseDown', async (button) => { await mouse.pressButton(BUTTON_MAP[button]); }),
    mouseUp: guard('mouseUp', async (button) => { await mouse.releaseButton(BUTTON_MAP[button]); }),
    scroll: guard('scroll', async (dx, dy) => { if (dy) await mouse.scrollDown(dy); if (dx) await mouse.scrollRight(dx); }),
    keyDown: guard('keyDown', async (key) => { const k = KEY_MAP[key]; if (k !== undefined) await keyboard.pressKey(k); else await keyboard.type(key); }),
    keyUp: guard('keyUp', async (key) => { const k = KEY_MAP[key]; if (k !== undefined) await keyboard.releaseKey(k); }),
  };
}
