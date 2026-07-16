import { expect, test, vi } from 'vitest';
import { createAccountClient } from '../src/account-client.js';
test('uploadDiagnostics POSTs bundle with bearer token', async () => {
  const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ id: 'DIAG1' }) }));
  const c = createAccountClient({ baseUrl: 'https://a', fetch: fetchImpl });
  const res = await c.uploadDiagnostics({ accessToken: 'T', meta: { app: 'host' }, files: { 'main.log': 'x' } });
  expect(res).toEqual({ ok: true, status: 201, data: { id: 'DIAG1' } });
  const [, init] = fetchImpl.mock.calls[0];
  expect(init.headers.authorization).toBe('Bearer T');
  expect(JSON.parse(init.body).files['main.log']).toBe('x');
});
