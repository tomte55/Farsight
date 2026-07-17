// The host's main window must NOT be background-throttled.
//
// Field bug (2026-07-17): the owner minimized the host while remote-controlling
// it — input died, the screen stream kept flowing, and reconnecting then reported
// "host is offline". Root cause: the signaling client, the peer connection and the
// input datachannel handler ALL live in the host RENDERER (renderer.js:2-3,280),
// and the host spends its life minimized or hidden to the tray. Chromium throttles
// a background renderer's timers — MEASURED against the packaged app over CDP:
// 4.00 ticks/s visible -> 1.10 ticks/s the moment the window was minimized
// (document.visibilityState flipped to "hidden"), degrading to ~1/MINUTE once
// intensive throttling kicks in after ~5 min. That stalls the signaling client's
// setTimeout-driven auto-reconnect, so a dropped socket can't self-heal — while
// the account heartbeat, which runs in MAIN and is never throttled, keeps
// reporting presence. Net effect is exactly what signaling-client.js's own header
// warns about: "the host keeps heartbeating presence (looks Online) while being
// unreachable → CONNECT returns host_offline".
//
// With backgroundThrottling:false the same probe measured 4.00/s while minimized
// (visibilityState stayed "visible" — the flag also gates the Page Visibility API).
//
// The hidden transfer workers already set this for the same reason
// (transfer-worker.js); the main windows were missed.
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

test('the prefs extractor really captures the whole block (guards the test itself)', () => {
  // It silently cut the flag off once; pin that it reaches the last property.
  const prefs = mainWindowPrefs(hostMain);
  expect(prefs).toMatch(/^webPreferences/);
  expect(prefs.endsWith('}')).toBe(true);
  expect(prefs).toContain('preload'); // first property
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
