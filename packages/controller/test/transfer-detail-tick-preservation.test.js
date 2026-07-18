// packages/controller/test/transfer-detail-tick-preservation.test.js
// Guard: Task 10's expandable transfer-detail panel must survive a plain
// progress tick. onTransferEvent fires renderTransfers() per-file and
// UNTHROTTLED (same as renderStatusBar/renderRail — see those functions' own
// comments) — a regression that made renderTransfers() unconditionally
// transfersListEl.replaceChildren() the list on every call would silently
// snap every OPEN detail panel shut (and blur focus on its Cancel/Details
// button) on the very next tick, and nothing else would notice: no other test
// references transferRowIds/transferRowEls/updateJobRow/expandedJobs/
// applyExpanded. Source-text guard — this project's convention for renderer
// wiring (transfer-remove-wiring.test.js, shell-wiring.test.js, importmap.
// test.js, etc.); there is no jsdom dependency installed in this repo
// (vitest.config.mjs pins environment: 'node' for the whole monorepo).
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const renderer = readFileSync(resolve(__dirname, '../src/renderer/renderer.js'), 'utf8');

function fnBody(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  expect(start, `missing ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(endMarker, start);
  expect(end, `missing ${endMarker} after ${startMarker}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('renderTransfers: an unchanged job-id set updates rows in place, never a bare rebuild', () => {
  const body = fnBody(renderer, 'function renderTransfers(', 'async function refreshTransfersList(');

  test('computes structureChanged from the job-id SET (added/removed jobs) up front', () => {
    expect(body).toMatch(/const structureChanged\s*=\s*ids\.length\s*!==\s*transferRowIds\.length/);
  });

  test('the unchanged-structure path updates existing rows via updateJobRow and returns — no replaceChildren before it', () => {
    const guardStart = body.indexOf('if (!structureChanged)');
    expect(guardStart).toBeGreaterThanOrEqual(0);
    const guardReturn = body.indexOf('return;', guardStart);
    expect(guardReturn).toBeGreaterThan(guardStart);
    const guardBlock = body.slice(guardStart, guardReturn);
    // The per-row update path — this is what a plain progress tick (same job-id
    // set) actually runs.
    expect(guardBlock).toMatch(/updateJobRow\(entry,\s*j\)/);
    // The whole point of the guard: an unchanged tick must never tear the list
    // down. If this ever matches, renderTransfers rebuilds on every tick again.
    expect(guardBlock).not.toContain('replaceChildren');
  });

  test('transfersListEl.replaceChildren() only happens in the structural-rebuild path (after the guard has already returned)', () => {
    const guardStart = body.indexOf('if (!structureChanged)');
    const guardReturn = body.indexOf('return;', guardStart);
    const rebuildAt = body.indexOf('transfersListEl.replaceChildren()', guardReturn);
    // Mutation target: an unconditional replaceChildren() at the top of the
    // function (before the guard even runs) would make this -1 (not found
    // after guardReturn) or land before it — either way this assertion catches it.
    expect(rebuildAt, 'replaceChildren() must exist, but ONLY after the unchanged-structure guard has returned').toBeGreaterThan(guardReturn);
  });

  test('a structural rebuild restores each row\'s prior open/closed detail-panel state via applyExpanded', () => {
    const guardReturn = body.indexOf('return;', body.indexOf('if (!structureChanged)'));
    const rebuildBlock = body.slice(guardReturn);
    expect(rebuildBlock).toMatch(/applyExpanded\(entry,\s*j\)/);
  });
});
