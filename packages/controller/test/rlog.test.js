import { expect, test, vi } from 'vitest';
import { createRendererLogger } from '../src/renderer/rlog.js';

test('forwards level, scope and truncated msg to the send sink', () => {
  const sent = [];
  const log = createRendererLogger('peer', (e) => sent.push(e));
  log.info('ice connected');
  log.child('sub').warn('x'.repeat(5000));
  expect(sent[0]).toEqual({ level: 'info', scope: 'peer', msg: 'ice connected' });
  expect(sent[1].scope).toBe('peer:sub');
  expect(sent[1].level).toBe('warn');
  expect(sent[1].msg.length).toBe(2000); // MAX_MSG backstop
});

test('never throws if the send sink throws', () => {
  const log = createRendererLogger('peer', () => { throw new Error('no ipc'); });
  expect(() => log.error('boom')).not.toThrow();
});
