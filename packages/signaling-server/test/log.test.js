// packages/signaling-server/test/log.test.js
import { expect, test, vi } from 'vitest';
import { createLogger } from '../src/log.js';

test('emits single-line JSON with ts and event', () => {
  const sink = vi.fn();
  const log = createLogger({ sink, now: () => '2026-07-11T00:00:00Z' });
  log.event('auth_fail', { id: '123', reason: 'bad_password' });
  const line = JSON.parse(sink.mock.calls[0][0]);
  expect(line).toEqual({ ts: '2026-07-11T00:00:00Z', event: 'auth_fail', id: '123', reason: 'bad_password' });
});
