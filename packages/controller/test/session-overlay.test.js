// packages/controller/test/session-overlay.test.js
import { expect, test } from 'vitest';
import { sessionOverlayFor } from '../src/session-overlay.js';

test('connected hides the overlay', () => {
  const o = sessionOverlayFor('connected');
  expect(o.visible).toBe(false);
  expect(o.kind).toBe('hidden');
});

test('connecting/new/checking show a connecting overlay with no actions', () => {
  for (const s of ['new', 'connecting', 'checking']) {
    const o = sessionOverlayFor(s);
    expect(o.visible).toBe(true);
    expect(o.kind).toBe('connecting');
    expect(o.actions).toEqual([]);
  }
});

test('transient disconnected shows a calm reconnecting overlay with no actions', () => {
  const o = sessionOverlayFor('disconnected');
  expect(o.visible).toBe(true);
  expect(o.kind).toBe('reconnecting');
  expect(o.title).toMatch(/reconnect/i);
  expect(o.actions).toEqual([]);
});

test('failed/closed show a terminal disconnected overlay with reconnect + close', () => {
  for (const s of ['failed', 'closed']) {
    const o = sessionOverlayFor(s);
    expect(o.visible).toBe(true);
    expect(o.kind).toBe('disconnected');
    expect(o.title).toMatch(/disconnect/i);
    expect(o.actions.map((a) => a.id)).toEqual(['reconnect', 'close']);
  }
});

test('peer_disconnected reason forces the disconnected overlay even if connState looks connected', () => {
  const o = sessionOverlayFor('connected', 'peer_disconnected');
  expect(o.visible).toBe(true);
  expect(o.kind).toBe('disconnected');
});

test('host_ended reason shows a terminal "session ended" overlay with reconnect + close', () => {
  const o = sessionOverlayFor('connected', 'host_ended');
  expect(o.visible).toBe(true);
  expect(o.kind).toBe('ended');
  expect(o.title).toMatch(/ended/i);
  expect(o.actions.map((a) => a.id)).toEqual(['reconnect', 'close']);
});
