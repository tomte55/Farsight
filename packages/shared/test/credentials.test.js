// packages/shared/test/credentials.test.js
import { expect, test } from 'vitest';
import { hashCredential, verifyCredential } from '../src/credentials.js';

test('hash then verify round-trips', async () => {
  const hash = await hashCredential('correct horse');
  expect(hash).toMatch(/^\$argon2/);
  expect(await verifyCredential(hash, 'correct horse')).toBe(true);
  expect(await verifyCredential(hash, 'wrong')).toBe(false);
});

test('verify returns false on malformed hash', async () => {
  expect(await verifyCredential('not-a-hash', 'x')).toBe(false);
});
