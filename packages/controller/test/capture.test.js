// packages/controller/test/capture.test.js
import { expect, test } from 'vitest';
import { pickPrimaryScreen, listDisplays, displaySourceId, monitorsForControl } from '../src/capture.js';

const fakeScreen = {
  getPrimaryDisplay: () => ({ id: 10 }),
  getAllDisplays: () => [
    { id: 10, label: 'Main', size: { width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 20, label: 'Side', size: { width: 1280, height: 720 }, bounds: { x: 1920, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 },
  ],
};

test('picks the source matching the primary display id', () => {
  const sources = [
    { id: 'screen:1', display_id: '111' },
    { id: 'screen:2', display_id: '222' },
  ];
  expect(pickPrimaryScreen(sources, '222').id).toBe('screen:2');
});

test('falls back to first source when no id matches', () => {
  const sources = [{ id: 'screen:1', display_id: '111' }];
  expect(pickPrimaryScreen(sources, '999').id).toBe('screen:1');
});

test('returns undefined for empty sources', () => {
  expect(pickPrimaryScreen([], '1')).toBeUndefined();
});

test('listDisplays marks primary and indexes', () => {
  const d = listDisplays(fakeScreen);
  expect(d[0]).toMatchObject({ index: 0, id: 10, primary: true });
  expect(d[1]).toMatchObject({ index: 1, id: 20, primary: false, scaleFactor: 1.5 });
});

test('displaySourceId matches by display_id', () => {
  const sources = [{ id: 'screen:a', display_id: '20' }, { id: 'screen:b', display_id: '10' }];
  const d = listDisplays(fakeScreen);
  expect(displaySourceId(sources, d[1])).toBe('screen:a');
});

test('monitorsForControl reduces to schema fields', () => {
  expect(monitorsForControl(listDisplays(fakeScreen))).toEqual([
    { index: 0, label: 'Main', width: 1920, height: 1080, primary: true },
    { index: 1, label: 'Side', width: 1280, height: 720, primary: false },
  ]);
});
