// packages/controller/test/session.test.js
import { expect, test, vi } from 'vitest';
import { createSession } from '../src/session.js';

test('consent flow: idle → pending → active', () => {
  const onStateChange = vi.fn();
  const s = createSession({ onStateChange });
  expect(s.state).toBe('idle');
  s.requestConsent(); expect(s.state).toBe('pending_consent');
  s.allow(); expect(s.state).toBe('active');
  expect(s.isActive()).toBe(true);
  expect(onStateChange).toHaveBeenCalledWith('pending_consent');
  expect(onStateChange).toHaveBeenCalledWith('active');
});

test('deny returns to idle', () => {
  const s = createSession({ onStateChange: () => {} });
  s.requestConsent(); s.deny();
  expect(s.state).toBe('idle');
});

test('end resets to idle and is not active', () => {
  const s = createSession({ onStateChange: () => {} });
  s.requestConsent(); s.allow(); s.end();
  expect(s.isActive()).toBe(false);
  expect(s.state).toBe('idle');
});

test('allow only works from pending_consent', () => {
  const s = createSession({ onStateChange: () => {} });
  s.allow(); // ignored from idle
  expect(s.state).toBe('idle');
});
