// packages/signaling-server/test/registry.test.js
import { expect, test } from 'vitest';
import { createRegistry } from '../src/registry.js';

test('registry add/get/has/remove', () => {
  const r = createRegistry();
  const sock = {};
  expect(r.has('1')).toBe(false);
  r.add('1', sock);
  expect(r.has('1')).toBe(true);
  expect(r.get('1')).toBe(sock);
  r.remove('1');
  expect(r.has('1')).toBe(false);
  expect(r.get('1')).toBeUndefined();
});
