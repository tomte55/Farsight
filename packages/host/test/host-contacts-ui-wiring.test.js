// packages/host/test/host-contacts-ui-wiring.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const html = read('../src/renderer/index.html');
const renderer = read('../src/renderer/renderer.js');

describe('host contacts panel wiring', () => {
  it('has a Contacts menu entry and panel', () => {
    expect(html).toMatch(/id="menu-contacts"/);
    expect(html).toMatch(/id="contacts-panel"/);
  });
  it('loads contacts and can accept/decline incoming requests + add by email', () => {
    expect(renderer).toMatch(/accountContacts\(\)/);
    expect(renderer).toMatch(/accountContactAdd\(/);
    expect(renderer).toMatch(/accountContactAccept\(/);
    expect(renderer).toMatch(/accountContactDecline\(/);
  });
});
