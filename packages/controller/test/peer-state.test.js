// packages/controller/test/peer-state.test.js
import { expect, test } from 'vitest';
import { describeConnectionState } from '../src/peer.js';

test('maps connection states to friendly text', () => {
  expect(describeConnectionState('connecting')).toMatch(/connecting/i);
  expect(describeConnectionState('connected')).toMatch(/connected/i);
  expect(describeConnectionState('failed')).toMatch(/failed|no route|blocked/i);
  expect(describeConnectionState('disconnected')).toMatch(/reconnect/i);
});
