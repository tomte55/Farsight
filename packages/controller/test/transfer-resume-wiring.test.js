// SP3 Phase 4 auto-resume: static wiring guards for the controller side. The live
// resume (drop/restore + close/reopen the app) is the maintainer's 2-machine E2E;
// here we assert the contract points line up (same style as the other *-wiring tests).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test, describe } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8');
const renderer = readFileSync(path.join(dir, '../src/renderer/renderer.js'), 'utf8');

describe('controller main: auto-resume wiring', () => {
  test('constructs the transfer service with a getFleet that maps device id -> deviceId', () => {
    expect(main).toMatch(/getFleet:\s*async/);
    expect(main).toMatch(/getAccountService\(\)\.fleet\(\)/);
    expect(main).toMatch(/deviceId:\s*d\.id/);
  });

  test('starts the resume watcher on launch (across-restart resume)', () => {
    expect(main).toMatch(/startResumeWatcher\(\)/);
  });

  test('transfer:send persists sourceRoots (the picked paths) for resume', () => {
    expect(main).toMatch(/startSend\(\{[^}]*sourceRoots:\s*paths/s);
  });

  test('getFleet merges accepted contacts into the resume-watcher presence feed', () => {
    expect(main).toMatch(/getAccountService\(\)\.contacts\(\)/);
    // maps a contact device's stable id + current signalingId, same shape as fleet devices
    expect(main).toMatch(/deviceId:\s*\w+\.deviceId/);
  });
});

describe('controller renderer: interrupted/reconnecting states', () => {
  test('maps interrupted + reconnecting transfer events to non-terminal states', () => {
    expect(renderer).toMatch(/ev\.type === 'interrupted'/);
    expect(renderer).toMatch(/ev\.type === 'reconnecting'/);
    expect(renderer).toMatch(/case 'interrupted':/);
    expect(renderer).toMatch(/case 'reconnecting':/);
    // must NOT be terminal, so they keep updating
    expect(renderer).toMatch(/TERMINAL_STATES = \['done', 'canceled', 'error', 'declined'\]/);
  });
});
