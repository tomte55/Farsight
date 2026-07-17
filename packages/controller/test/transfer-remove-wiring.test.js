// packages/controller/test/transfer-remove-wiring.test.js
// Guard: finished transfers can be removed from the list (per-row Remove +
// "Clear finished"), wired through a transfer:remove IPC to the service's
// removeJob. Source-text guards (project convention).
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const renderer = readFileSync(resolve(__dirname, '../src/renderer/renderer.js'), 'utf8');
const html = readFileSync(resolve(__dirname, '../src/renderer/index.html'), 'utf8');
const main = readFileSync(resolve(__dirname, '../src/main.js'), 'utf8');
const preload = readFileSync(resolve(__dirname, '../src/preload.cjs'), 'utf8');

describe('transfer removal wiring', () => {
  test('preload exposes transferRemove → transfer:remove', () => {
    expect(preload).toMatch(/transferRemove:\s*\(jobId\)\s*=>\s*ipcRenderer\.invoke\('transfer:remove'/);
  });
  test('main handles transfer:remove via the service removeJob', () => {
    expect(main).toContain("ipcMain.handle('transfer:remove'");
    const h = main.slice(main.indexOf("ipcMain.handle('transfer:remove'"), main.indexOf("ipcMain.handle('transfer:remove'") + 200);
    expect(h).toMatch(/removeJob\(/);
  });
  test('a terminal job row shows a Remove button that calls transferRemove', () => {
    const fn = renderer.slice(renderer.indexOf('function jobRow('), renderer.indexOf('function renderTransfers('));
    expect(fn).toContain('transferRemove(');
    // Remove is the terminal-state branch (the else of the active/Cancel branch).
    expect(fn).toMatch(/else\s*\{[\s\S]*Remove[\s\S]*transferRemove\(/);
  });
  test('the panel has a "Clear finished" control wired to a bulk remove', () => {
    expect(html).toContain('id="transfers-clear"');
    expect(renderer).toContain("getElementById('transfers-clear')");
    expect(renderer).toMatch(/function clearFinishedTransfers\(/);
    const fn = renderer.slice(renderer.indexOf('async function clearFinishedTransfers('), renderer.indexOf('async function clearFinishedTransfers(') + 500);
    expect(fn).toContain('TERMINAL_TRANSFER_STATES');
    expect(fn).toContain('transferRemove(');
  });
});
