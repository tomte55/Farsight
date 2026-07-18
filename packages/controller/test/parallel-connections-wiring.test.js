// Plan 3 Task 6: "Parallel connections" setting — static wiring guards, mirroring
// the repo's existing wiring-test style (received-dir-wiring.test.js): parse the
// source files and assert the contract points line up. main.js imports 'electron'
// at module scope so it can only be verified via text-based assertions here (same
// convention as openchannel-multiflow.test.js's main.js describe block); the
// clamp/default logic itself (resolveParallelConnections) is a REAL executable
// test in packages/shared/test/config.test.js.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test, describe } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8');
const preload = readFileSync(path.join(dir, '../src/preload.cjs'), 'utf8');
const html = readFileSync(path.join(dir, '../src/renderer/index.html'), 'utf8');
const renderer = readFileSync(path.join(dir, '../src/renderer/renderer.js'), 'utf8');

describe('main.js: parallel-connections setting', () => {
  test('imports resolveParallelConnections from @farsight/shared/config', () => {
    expect(main).toMatch(/import\s*\{[^}]*\bresolveParallelConnections\b[^}]*\}\s*from\s*['"]@farsight\/shared\/config['"]/);
  });
  test('parallelConnections() reads parallelConnections from stored config through resolveParallelConnections', () => {
    expect(main).toMatch(/function parallelConnections\(\)/);
    expect(main).toMatch(/resolveParallelConnections\(readStoredConfig\(\)\.parallelConnections\)/);
  });
  test('registers the two parallel-connections IPC channels', () => {
    for (const ch of ['parallel-connections:get', 'parallel-connections:set']) {
      expect(main).toContain(`'${ch}'`);
    }
  });
  test('set merges onto readStoredConfig (does not clobber signalingUrl/controlAllowed/receivedFilesDir)', () => {
    expect(main).toMatch(/serializeConfig\(\s*\{\s*\.\.\.readStoredConfig\(\),\s*parallelConnections:\s*n\s*\}\s*\)/);
  });
  test('transfer:send resolves flowCount from the setting unless the caller already gave one, and never sends a bare target', () => {
    expect(main).toMatch(/Number\.isInteger\(target\.flowCount\)\s*&&\s*target\.flowCount\s*>\s*0\s*\n\s*\?\s*resolveParallelConnections\(target\.flowCount\)\s*:\s*parallelConnections\(\)/);
    expect(main).toMatch(/const sendTarget = \{ \.\.\.target, flowCount \};/);
    expect(main).toMatch(/startSend\(\{\s*jobId,\s*manifest,\s*sources,\s*target:\s*sendTarget,\s*sourceRoots:\s*paths\s*\}\)/);
  });
  // Task 6 review fix: a target.flowCount override must be routed through the
  // SAME [1,32] clamp (resolveParallelConnections) the ambient setting uses —
  // not passed through raw — so a stray/adversarial value (e.g. 1000) can never
  // reach the multi-flow branch un-clamped from this earlier call site either
  // (transfer-service.js's resolveFlowCount is the other, last-line choke point).
  test('an explicit target.flowCount override is clamped via resolveParallelConnections, not passed through raw', () => {
    expect(main).toMatch(/Number\.isInteger\(target\.flowCount\)\s*&&\s*target\.flowCount\s*>\s*0\s*\n\s*\?\s*resolveParallelConnections\(target\.flowCount\)\s*:\s*parallelConnections\(\)/);
  });
});

describe('preload: parallel-connections bridge', () => {
  test('exposes get/set over the IPC bridge', () => {
    expect(preload).toMatch(/getParallelConnections:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('parallel-connections:get'\)/);
    expect(preload).toMatch(/setParallelConnections:\s*\(n\)\s*=>\s*ipcRenderer\.invoke\('parallel-connections:set',\s*n\)/);
  });
});

describe('renderer: parallel-connections settings field', () => {
  test('settings has a 1-32 numeric field + Save button', () => {
    expect(html).toMatch(/id="settings-parallel-connections"[^>]*type="number"/);
    expect(html).toMatch(/id="settings-parallel-connections"[^>]*min="1"/);
    expect(html).toMatch(/id="settings-parallel-connections"[^>]*max="32"/);
    expect(html).toMatch(/id="menu-save-parallel-connections"/);
  });
  test('renderer wires Save to setParallelConnections and refreshes from getParallelConnections', () => {
    expect(renderer).toMatch(/setParallelConnections\(n\)/);
    expect(renderer).toMatch(/getParallelConnections\(\)\.then/);
  });
  test('renderer clamps the field value into [1,32] before saving', () => {
    expect(renderer).toMatch(/Math\.min\(32,\s*Math\.max\(1,/);
  });
});
