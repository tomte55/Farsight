// Plan 3 Task 7: pause/resume/reorder/queue-order IPC + the "Rate limit"
// setting's IPC pair — static wiring guards, mirroring the repo's existing
// wiring-test style (parallel-connections-wiring.test.js): parse the source
// files and assert the contract points line up. main.js imports 'electron' at
// module scope so it can only be verified via text-based assertions here.
// Renderer wiring (buttons, settings field) is deferred to Plan 4 — only
// main.js + preload.cjs are in scope for this task.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test, describe } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8');
const preload = readFileSync(path.join(dir, '../src/preload.cjs'), 'utf8');

describe('main.js: transfer pause/resume/reorder/queue-order IPC', () => {
  test('registers transfer:pause delegating to getTransferService().pause(jobId)', () => {
    expect(main).toMatch(/ipcMain\.handle\('transfer:pause',\s*(?:async\s*)?\(_e,\s*jobId\)\s*=>\s*getTransferService\(\)\.pause\(jobId\)\)/);
  });
  test('registers transfer:resume delegating to getTransferService().resume(jobId)', () => {
    expect(main).toMatch(/ipcMain\.handle\('transfer:resume',\s*(?:async\s*)?\(_e,\s*jobId\)\s*=>\s*getTransferService\(\)\.resume\(jobId\)\)/);
  });
  test('registers transfer:reorder delegating to getTransferService().reorder(jobId, dir)', () => {
    expect(main).toMatch(/ipcMain\.handle\('transfer:reorder',\s*(?:async\s*)?\(_e,\s*\{\s*jobId,\s*dir\s*\}\)\s*=>\s*getTransferService\(\)\.reorder\(jobId,\s*dir\)\)/);
  });
  test('registers transfer:queue-order delegating to getTransferService().queueOrder()', () => {
    expect(main).toMatch(/ipcMain\.handle\('transfer:queue-order',\s*(?:async\s*)?\(\)\s*=>\s*getTransferService\(\)\.queueOrder\(\)\)/);
  });
});

describe('main.js: rate-limit setting (mirrors parallel-connections exactly)', () => {
  test('imports resolveRateLimit from @farsight/shared/config', () => {
    expect(main).toMatch(/import\s*\{[^}]*\bresolveRateLimit\b[^}]*\}\s*from\s*['"]@farsight\/shared\/config['"]/);
  });
  test('rateLimit() reads rateLimitMbps from stored config through resolveRateLimit', () => {
    expect(main).toMatch(/function rateLimit\(\)/);
    expect(main).toMatch(/resolveRateLimit\(readStoredConfig\(\)\.rateLimitMbps\)/);
  });
  test('registers the two rate-limit IPC channels', () => {
    for (const ch of ['rate-limit:get', 'rate-limit:set']) {
      expect(main).toContain(`'${ch}'`);
    }
  });
  test('set merges onto readStoredConfig (does not clobber sibling config keys) and writes mode 0o600', () => {
    expect(main).toMatch(/serializeConfig\(\s*\{\s*\.\.\.readStoredConfig\(\),\s*rateLimitMbps:\s*n\s*\}\s*\)/);
    expect(main).toMatch(/writeFileSync\(configFilePath\(\),\s*serializeConfig\(\s*\{\s*\.\.\.readStoredConfig\(\),\s*rateLimitMbps:\s*n\s*\}\s*\),\s*\{\s*encoding:\s*'utf8',\s*mode:\s*0o600\s*\}\)/);
  });
  test('set applies the new rate live via getTransferService().setRateLimit(n)', () => {
    expect(main).toMatch(/getTransferService\(\)\.setRateLimit\(n\)/);
  });
});

describe('main.js: transfer service construction threads the rate limit', () => {
  test('createTransferService is constructed with rateLimitMbps: rateLimit()', () => {
    expect(main).toMatch(/createTransferService\(\{[\s\S]*?rateLimitMbps:\s*rateLimit\(\)/);
  });
});

describe('preload: pause/resume/reorder/queue-order + rate-limit bridges', () => {
  test('exposes transferPause/transferResume', () => {
    expect(preload).toMatch(/transferPause:\s*\(jobId\)\s*=>\s*ipcRenderer\.invoke\('transfer:pause',\s*jobId\)/);
    expect(preload).toMatch(/transferResume:\s*\(jobId\)\s*=>\s*ipcRenderer\.invoke\('transfer:resume',\s*jobId\)/);
  });
  test('exposes transferReorder(jobId, dir) and transferQueueOrder', () => {
    expect(preload).toMatch(/transferReorder:\s*\(jobId,\s*dir\)\s*=>\s*ipcRenderer\.invoke\('transfer:reorder',\s*\{\s*jobId,\s*dir\s*\}\)/);
    expect(preload).toMatch(/transferQueueOrder:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('transfer:queue-order'\)/);
  });
  test('exposes getRateLimit/setRateLimit', () => {
    expect(preload).toMatch(/getRateLimit:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('rate-limit:get'\)/);
    expect(preload).toMatch(/setRateLimit:\s*\(mbps\)\s*=>\s*ipcRenderer\.invoke\('rate-limit:set',\s*mbps\)/);
  });
});
