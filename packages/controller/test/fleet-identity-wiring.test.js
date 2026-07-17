// packages/controller/test/fleet-identity-wiring.test.js
// Guards for the fleet-console fixes:
//  (a) devices are named by machine hostname, not a hardcoded "Controller";
//  (b) the current device is filtered out of its own fleet list;
//  (c) each row can be removed (server-side revoke) to prune stale devices.
// Source-text guards (project convention: no DOM render in vitest node env).
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const renderer = readFileSync(resolve(__dirname, '../src/renderer/renderer.js'), 'utf8');
const main = readFileSync(resolve(__dirname, '../src/main.js'), 'utf8');
const preload = readFileSync(resolve(__dirname, '../src/preload.cjs'), 'utf8');

describe('(a) device naming by hostname', () => {
  test('the renderer no longer sends a hardcoded deviceName at login', () => {
    expect(renderer).not.toMatch(/deviceName:\s*'Controller'/);
  });
  test('main sets deviceName from os.hostname() authoritatively on login', () => {
    const handler = main.slice(main.indexOf("ipcMain.handle('account:login'"), main.indexOf("ipcMain.handle('account:login'") + 800);
    expect(handler).toMatch(/deviceName:\s*os\.hostname\(\)/);
  });
});

describe('(b) self is filtered from the fleet list', () => {
  test('loadFleet fetches this device id and filters it out', () => {
    const fn = renderer.slice(renderer.indexOf('async function loadFleet('), renderer.indexOf('function renderFleet('));
    expect(fn).toContain('connAuthDeviceId(');
    expect(fn).toMatch(/\.filter\(\([^)]*\)\s*=>[^)]*\.id\s*!==\s*myDeviceId/);
  });
});

describe('(c) a fleet device can be removed (revoke)', () => {
  test('preload exposes accountRevokeDevice → account:revoke-device', () => {
    expect(preload).toMatch(/accountRevokeDevice:\s*\(deviceId\)\s*=>\s*ipcRenderer\.invoke\('account:revoke-device'/);
  });
  test('main handles account:revoke-device via the account service', () => {
    expect(main).toContain("ipcMain.handle('account:revoke-device'");
    const handler = main.slice(main.indexOf("ipcMain.handle('account:revoke-device'"), main.indexOf("ipcMain.handle('account:revoke-device'") + 200);
    expect(handler).toMatch(/revokeDevice\(/);
  });
  test('hostRow renders a Remove button that calls accountRevokeDevice and reloads', () => {
    const fn = renderer.slice(renderer.indexOf('function hostRow('), renderer.indexOf('function lastSeenText('));
    expect(fn).toContain('accountRevokeDevice(');
    expect(fn).toContain('loadFleet(');
    // it must target THIS row's device id
    expect(fn).toMatch(/accountRevokeDevice\(d\.id\)/);
  });
});

describe('online/offline is shown by the dot, not text', () => {
  test('hostRow no longer writes an "Online"/"Offline" status label', () => {
    const fn = renderer.slice(renderer.indexOf('function hostRow('), renderer.indexOf('function lastSeenText('));
    expect(fn).not.toMatch(/textContent\s*=\s*d\.online\s*\?\s*'Online'/);
  });
});
