// packages/shared/src/shell-nav.js
// Pure model for the main window's rail navigation (unification step 1).
// Runtime-agnostic — no DOM, no node: imports — so it unit-tests in isolation and
// is safe to import from the sandboxed renderer via the import map.

export const SHELL_PAGES = Object.freeze(['home', 'fleet', 'people', 'transfers', 'settings']);

const LABELS = Object.freeze({
  home: 'Home',
  fleet: 'Fleet',
  people: 'People',
  transfers: 'Transfers',
  settings: 'Settings',
});

// Text glyphs, not an icon font: the renderer's CSP forbids remote assets and the
// Aurora language already leans on typographic marks (see farsight.css .wm .glyph).
const ICONS = Object.freeze({
  home: '⌂',
  fleet: '▤',
  people: '☺',
  transfers: '⇅',
  settings: '⚙',
});

export function isShellPage(name) {
  return SHELL_PAGES.includes(name);
}

// The transfer states a job never leaves. Single source of truth: renderer.js used
// to define this list locally, and the host renderer keeps its own copy.
export const TERMINAL_TRANSFER_STATES = Object.freeze(['done', 'canceled', 'error', 'declined', 'completed_with_errors']);

// A job with no state yet has not settled, so it counts — a fresh job seeded by
// onTransferEvent before its first typed event must still light the rail badge.
export function activeTransferCount(jobs) {
  if (!Array.isArray(jobs)) return 0;
  return jobs.filter((j) => !TERMINAL_TRANSFER_STATES.includes(j && j.state)).length;
}

export function railItems({ active, transferCount = 0 } = {}) {
  return SHELL_PAGES.map((page) => ({
    page,
    label: LABELS[page],
    icon: ICONS[page],
    selected: page === active,
    badge: page === 'transfers' && transferCount > 0 ? transferCount : null,
  }));
}
