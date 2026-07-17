import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const src = readFileSync(new URL('../src/renderer/renderer.js', import.meta.url), 'utf8');

test('host renderer imports the rate helpers it renders with', () => {
  expect(src).toContain("from '@farsight/shared/transfer-rate'");
  expect(src).toMatch(/import \{[^}]*createRateEstimator[^}]*\} from '@farsight\/shared\/transfer-rate'/);
});

test('interrupted is NOT terminal on the receiver — a resumed job must reuse its row', () => {
  // The freeze list must not contain 'interrupted': the sender re-establishes with
  // the SAME jobId, so freezing the row would drop every resumed event.
  expect(src).toMatch(/const RECV_TERMINAL_STATES = \['done', 'error', 'canceled'\]/);
  expect(src).not.toMatch(/RECV_TERMINAL_STATES.*interrupted/);
});

test('host no longer infers completion from fraction >= 1', () => {
  expect(src).not.toContain('fraction >= 1 ?');
});

test('host handles the real terminal + phase events', () => {
  expect(src).toContain("ev.type === 'completed'");
  expect(src).toContain("ev.type === 'verifying'");
  expect(src).toContain("ev.type === 'canceled'");
});

test('host receive rows offer a Cancel button', () => {
  expect(src).toContain('window.farsightIpc.transferCancel');
});
