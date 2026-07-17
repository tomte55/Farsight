// The controller's main window must NOT be background-throttled — per-package
// guard, mirroring packages/host/test/window-throttling.test.js (which carries
// the full measurements). Every other app-specific assertion in this repo is
// per-package (importmap/theme-css/version-tag), so the controller guards its own.
//
// Mechanism (measured, see the host's test): a minimized — or merely covered —
// window's renderer drops to Windows Idle priority and starves under CPU
// contention. This renderer owns input capture and the peer connection.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

// Brace-matched rather than sliced by a magic length (a fixed window silently cut
// the flag off in the host's version of this test). This app's main.js declares
// exactly one BrowserWindow — the transfer worker lives in transfer-worker.js.
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

test('the controller main window disables background throttling', () => {
  expect(mainWindowPrefs(main)).toMatch(/backgroundThrottling:\s*false/);
});

test('the controller main window keeps its sandboxed-renderer hardening', () => {
  // Regression guard: the throttling fix must not have loosened R-7.
  const prefs = mainWindowPrefs(main);
  expect(prefs).toMatch(/sandbox:\s*true/);
  expect(prefs).toMatch(/contextIsolation:\s*true/);
  expect(prefs).toMatch(/nodeIntegration:\s*false/);
});

// Unification step 2: the remote-control session moved into its own
// BrowserWindow, declared in session-window.js rather than main.js. It owns
// input capture and the peer connection exactly like the shell's main window
// used to, so it needs the identical hardening — guard it here too, reusing
// the same brace-matching extractor (mainWindowPrefs finds the FIRST
// webPreferences block in whichever source string it's given).
const sessionWindowSrc = readFileSync(new URL('../src/session-window.js', import.meta.url), 'utf8');

test('the session window sets backgroundThrottling:false and the R-7 trio', () => {
  const prefs = mainWindowPrefs(sessionWindowSrc);
  expect(prefs).toMatch(/backgroundThrottling:\s*false/);
  expect(prefs).toMatch(/sandbox:\s*true/);
  expect(prefs).toMatch(/contextIsolation:\s*true/);
  expect(prefs).toMatch(/nodeIntegration:\s*false/);
});
