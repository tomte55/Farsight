// Copy-ID button on the diagnostics upload result — static wiring guards, mirroring
// the repo's wiring-test style (received-dir-wiring.test.js / controller-transfer-ui-wiring.test.js):
// the diagnostics reference id is the only handle support has on an uploaded bundle
// and is read off-device, so it must be one-tap copyable rather than transcribed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test, describe } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, '../src/renderer/index.html'), 'utf8');
const renderer = readFileSync(path.join(dir, '../src/renderer/renderer.js'), 'utf8');

describe('index.html: diagnostics copy-id button', () => {
  test('has a Copy ID button wired to the shared .cbtn[data-copy] handler, targeting menu-diag-id', () => {
    // The button must carry class cbtn + data-copy="menu-diag-id" so the generic
    // copy handler picks it up at load; a substring check isn't enough — assert the
    // three attributes co-occur on one element.
    expect(html).toMatch(/<button[^>]*id="menu-copy-diag-id"[^>]*class="cbtn"[^>]*data-copy="menu-diag-id"[^>]*>/);
  });
  test('has the hidden menu-diag-id element that holds the raw id to copy', () => {
    expect(html).toMatch(/id="menu-diag-id"[^>]*hidden/);
  });
  test('the copy button starts hidden (only revealed after a successful upload)', () => {
    expect(html).toMatch(/id="menu-copy-diag-id"[^>]*hidden/);
  });
});

describe('renderer.js: diagnostics copy-id wiring', () => {
  test('on a successful upload, sets the raw id on menu-diag-id and reveals the copy button', () => {
    expect(renderer).toMatch(/menuDiagId\.textContent\s*=\s*res\.id/);
    expect(renderer).toMatch(/menuCopyDiagId\.hidden\s*=\s*false/);
  });
  test('hides the copy button on a fresh attempt (no stale prior id)', () => {
    // The `hidden = true` reset must appear before the await, so a failed/canceled
    // re-attempt doesn't leave a previous id's copy button showing.
    const handler = renderer.slice(renderer.indexOf('menuSendDiagnostics.addEventListener'));
    const resetIdx = handler.indexOf('menuCopyDiagId.hidden = true');
    const awaitIdx = handler.indexOf('await window.farsightIpc.sendDiagnostics()');
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(awaitIdx).toBeGreaterThan(resetIdx);
  });
  test('the shared copy handler copies the target element\'s textContent to the clipboard', () => {
    // The button relies on the existing generic handler (no bespoke listener), which
    // reads el.dataset.copyValue || el.textContent and writes it to the clipboard.
    expect(renderer).toMatch(/querySelectorAll\('\.cbtn\[data-copy\]'\)/);
    expect(renderer).toMatch(/navigator\.clipboard\.writeText\(text\)/);
  });
});
