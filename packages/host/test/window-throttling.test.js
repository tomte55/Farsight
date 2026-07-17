// Both apps' main windows must NOT be background-throttled.
//
// Field bug (2026-07-17): the owner minimized the host while remote-controlling
// it and input stopped working, while the screen stream kept flowing.
//
// Root cause is renderer PROCESS PRIORITY, not timer throttling. The input
// datachannel handler lives in the host renderer (renderer.js:280); Chromium
// drops a minimized — or merely COVERED — window's renderer to Windows Idle
// priority, and an active host saturates its own CPU (desktopCapturer + video
// encode), so the renderer starves. Measured on the real topology (sender ->
// input datachannel -> minimized receiver -> IPC to main), CPU contended:
//   Idle priority (default): 4084ms avg input latency, 10879ms max, 26% lost
//   Normal (this flag):      4ms avg, 29ms max, none lost
// The video survives because media runs off the renderer main thread — exactly
// the reported symptom. transfer-worker.js:55-58 already documents this same
// mechanism for the hidden workers; the main windows were missed.
//
// Timer throttling IS observable (4/s -> 1.1/s minimized) but is NOT the cause:
// datachannel delivery measured identical with and without the flag on an idle
// machine. Nor does it explain the separate "host is offline" report — a real
// socket drop reconnected in 1853ms even after 7.5 min minimized, so the
// signaling client's auto-reconnect self-heals fine. That bug is still open.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const hostMain = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const controllerMain = readFileSync(new URL('../../controller/src/main.js', import.meta.url), 'utf8');

// Return the app main window's webPreferences OBJECT text, brace-matched rather
// than sliced by a magic length (the block carries a long rationale comment, and
// a fixed window silently cut the flag off). Each app's main.js declares exactly
// one BrowserWindow — the transfer workers live in transfer-worker.js — so their
// setting can't satisfy this by accident.
function mainWindowPrefs(src) {
  const start = src.indexOf('webPreferences');
  expect(start).toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced webPreferences block');
}

test('the prefs extractor captures the whole block and nothing past it', () => {
  // Guards the TEST: a fixed-length slice once truncated the block and cut the
  // flag off, producing a false failure. `startsWith`/`endsWith('}')` assertions
  // are tautologies of the extractor's construction and pass even when truncated
  // — so assert the two things truncation/bleed would actually break: it reaches
  // the LAST property, and it stops before the code that follows the object.
  const prefs = mainWindowPrefs(hostMain);
  expect(prefs).toContain('preload');              // reaches the first property
  expect(prefs).toContain('backgroundThrottling'); // ...and the last one
  expect(prefs).not.toContain('loadFile');         // ...without bleeding past the block
});

test('the host main window disables background throttling', () => {
  // Without this a minimized/tray-hidden host stops reconnecting its signaling
  // socket and stops injecting input, while still reporting itself Online.
  expect(mainWindowPrefs(hostMain)).toMatch(/backgroundThrottling:\s*false/);
});

test('the controller main window disables background throttling', () => {
  // Mirrors the host: this renderer owns the signaling client, the peer
  // connection and input capture.
  expect(mainWindowPrefs(controllerMain)).toMatch(/backgroundThrottling:\s*false/);
});

test('both apps still keep the sandboxed-renderer hardening alongside it', () => {
  // Regression guard: the throttling fix must not have loosened R-7.
  for (const src of [hostMain, controllerMain]) {
    const prefs = mainWindowPrefs(src);
    expect(prefs).toMatch(/sandbox:\s*true/);
    expect(prefs).toMatch(/contextIsolation:\s*true/);
    expect(prefs).toMatch(/nodeIntegration:\s*false/);
  }
});
