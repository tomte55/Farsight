// packages/shared/test/shell-nav.test.js
import { describe, test, expect } from 'vitest';
import {
  SHELL_PAGES,
  isShellPage,
  TERMINAL_TRANSFER_STATES,
  activeTransferCount,
  railItems,
} from '../src/shell-nav.js';

describe('shell page ids', () => {
  test('the rail has exactly the five spec pages, home first', () => {
    expect([...SHELL_PAGES]).toEqual(['home', 'fleet', 'people', 'transfers', 'settings']);
  });

  test('isShellPage accepts known pages and rejects anything else', () => {
    expect(isShellPage('home')).toBe(true);
    expect(isShellPage('settings')).toBe(true);
    expect(isShellPage('screen')).toBe(false);
    expect(isShellPage('')).toBe(false);
    expect(isShellPage(undefined)).toBe(false);
  });
});

describe('activeTransferCount', () => {
  test('counts only non-terminal jobs', () => {
    const jobs = [
      { state: 'active' },
      { state: 'awaiting-approval' },
      { state: 'interrupted' },
      { state: 'done' },
      { state: 'canceled' },
      { state: 'error' },
      { state: 'declined' },
      { state: 'completed_with_errors' },
    ];
    expect(activeTransferCount(jobs)).toBe(3);
  });

  test('a job with no state counts as active (it has not settled)', () => {
    expect(activeTransferCount([{}])).toBe(1);
  });

  test('is zero for an empty or missing list', () => {
    expect(activeTransferCount([])).toBe(0);
    expect(activeTransferCount(undefined)).toBe(0);
  });

  // F-A4: 'completed_with_errors' is a terminal state (a finished job with some
  // per-file failures) — it must not keep lighting the rail badge as if the
  // job were still moving.
  test('a completed_with_errors job is treated as terminal, not active', () => {
    expect(activeTransferCount([{ state: 'completed_with_errors' }])).toBe(0);
  });

  test('TERMINAL_TRANSFER_STATES matches the renderer freeze list', () => {
    expect([...TERMINAL_TRANSFER_STATES]).toEqual(['done', 'canceled', 'error', 'declined', 'completed_with_errors']);
  });
});

describe('railItems', () => {
  test('returns one item per page, in order, with the active one selected', () => {
    const items = railItems({ active: 'fleet' });
    expect(items.map((i) => i.page)).toEqual(['home', 'fleet', 'people', 'transfers', 'settings']);
    expect(items.filter((i) => i.selected).map((i) => i.page)).toEqual(['fleet']);
  });

  test('every item carries a human label and an icon', () => {
    for (const item of railItems({ active: 'home' })) {
      expect(item.label).toBeTruthy();
      expect(item.icon).toBeTruthy();
    }
  });

  test('only transfers carries a badge, and only when non-zero', () => {
    const none = railItems({ active: 'home', transferCount: 0 });
    expect(none.every((i) => i.badge === null)).toBe(true);

    const some = railItems({ active: 'home', transferCount: 3 });
    const badged = some.filter((i) => i.badge !== null);
    expect(badged).toHaveLength(1);
    expect(badged[0].page).toBe('transfers');
    expect(badged[0].badge).toBe(3);
  });

  test('an unknown active page selects nothing rather than throwing', () => {
    const items = railItems({ active: 'nope' });
    expect(items.every((i) => i.selected === false)).toBe(true);
  });
});
