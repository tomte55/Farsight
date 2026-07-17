// packages/controller/test/shell-wiring.test.js
// Static guards for the unification step-1 shell. The project does not run DOM
// tests (vitest environment:'node'); renderer wiring is guarded by source-text
// assertions plus the headless-Electron probe (shell-launch.probe.mjs), which is
// what supplies POSITIVE proof the module graph executed.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, '../src/renderer/index.html'), 'utf8');
const js = readFileSync(resolve(__dirname, '../src/renderer/renderer.js'), 'utf8');

function cspContent(src) {
  const m = src.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/);
  return m ? m[1] : '';
}
function directive(csp, name) {
  return csp.split(';').map((s) => s.trim()).find((d) => d.startsWith(name)) || '';
}
function importMapCspHash(src) {
  const m = src.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  if (!m) return null;
  // CRLF→LF: the files are CRLF on disk but Chromium's parser normalizes newlines
  // per spec before hashing, so the raw bytes would not match.
  const normalized = m[1].replace(/\r\n/g, '\n');
  return `sha256-${createHash('sha256').update(normalized, 'utf8').digest('base64')}`;
}

describe('rail navigation', () => {
  test('markup has a rail and one page container per shell page', () => {
    expect(html).toContain('id="rail"');
    for (const page of ['home', 'fleet', 'people', 'transfers', 'settings']) {
      expect(html, `missing #page-${page}`).toContain(`id="page-${page}"`);
    }
  });

  test('markup has the persistent status bar', () => {
    expect(html).toContain('id="statusbar"');
  });

  test('the settings cog and its dropdown are gone — the rail replaces them', () => {
    expect(html).not.toContain('id="settings-cog"');
    expect(html).not.toContain('id="settings-menu"');
  });

  test('renderer builds the rail from the shared pure model, not a hand-rolled list', () => {
    expect(js).toContain("from '@farsight/shared/shell-nav'");
    expect(js).toMatch(/railItems\(/);
  });

  test('renderer routes through ONE showPage function', () => {
    expect(js).toMatch(/function showPage\(/);
    // The old shell wrote the "hide every sibling" list out four times (openFleet,
    // openContacts, openSendPanel, openTransfersPanel) and a partial fifth. If any
    // survive, the router is not the single source of truth.
    for (const gone of ['function openFleet(', 'function openContacts(', 'function openSendPanel(', 'function openTransfersPanel(']) {
      expect(js, `${gone} must be replaced by showPage()`).not.toContain(gone);
    }
  });

  test('renderer imports the terminal-state list from shared instead of redefining it', () => {
    expect(js).not.toMatch(/const TERMINAL_STATES\s*=/);
    expect(js).toContain('TERMINAL_TRANSFER_STATES');
  });
});

describe('CSP', () => {
  test("script-src no longer needs 'unsafe-inline' — the importmap is pinned by hash", () => {
    const scriptSrc = directive(cspContent(html), 'script-src');
    expect(scriptSrc, 'index.html must declare script-src').toBeTruthy();
    const hash = importMapCspHash(html);
    expect(hash).toBeTruthy();
    expect(scriptSrc).toContain(`'${hash}'`);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  test("style-src no longer needs 'unsafe-inline' — all styling is in the stylesheet", () => {
    const styleSrc = directive(cspContent(html), 'style-src');
    expect(styleSrc, 'index.html must declare style-src').toBeTruthy();
    expect(styleSrc).not.toContain("'unsafe-inline'");
  });

  test('the containment directives are unchanged', () => {
    const csp = cspContent(html);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' wss: ws:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });
});

describe('no inline styling', () => {
  test('no style="..." attributes survive — a CSP hash covers <style>, not attributes', () => {
    const attrs = html.match(/\sstyle="[^"]*"/g) || [];
    expect(attrs, `remove these inline styles: ${attrs.join(' | ')}`).toEqual([]);
  });

  test('no inline <style> block survives — it lives in farsight.css', () => {
    expect(html).not.toMatch(/<style>/);
  });
});
