// packages/controller/test/controller-contacts-ui-wiring.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const html = read('../src/renderer/index.html');
const renderer = read('../src/renderer/renderer.js');

describe('controller contacts panel wiring', () => {
  // Unification step 1: contacts moved from a standalone menu entry + full-screen
  // panel to the "People" rail page (shell-wiring.test.js guards the rail itself;
  // this guards that the contacts UI actually lives inside that page).
  it('has a People page reachable from the rail, with the contacts list container', () => {
    expect(html).toMatch(/id="page-people"/);
    expect(html).toMatch(/id="contacts-list"/);
  });
  it('loads contacts and renders add/accept/decline + send', () => {
    expect(renderer).toMatch(/accountContacts\(\)/);
    expect(renderer).toMatch(/accountContactAdd\(/);
    expect(renderer).toMatch(/accountContactAccept\(/);
    expect(renderer).toMatch(/accountContactDecline\(/);
    // a contact send carries contact:true
    expect(renderer).toMatch(/contact:\s*true/);
  });
});
