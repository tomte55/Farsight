// packages/shared/test/transfer-label.test.js
import { describe, test, expect } from 'vitest';
import { transferLabel } from '../src/transfer-label.js';

describe('transferLabel', () => {
  test('a folder send is labelled by the folder name (from sourceRoots)', () => {
    expect(transferLabel({ sourceRoots: ['C:\\Users\\me\\Holiday Photos'] })).toBe('Holiday Photos');
    expect(transferLabel({ sourceRoots: ['/home/me/game-build'] })).toBe('game-build');
  });

  test('several picked roots show the first + a count', () => {
    expect(transferLabel({ sourceRoots: ['C:\\a\\one.zip', 'C:\\a\\two.zip', 'C:\\a\\three.zip'] })).toBe('one.zip +2');
  });

  test('a received folder (no sourceRoots) is labelled from the manifest top segment', () => {
    const manifest = { entries: [{ path: 'myfolder/a.txt' }, { path: 'myfolder/sub/b.txt' }] };
    expect(transferLabel({ manifest })).toBe('myfolder');
  });

  test('a single received file is labelled by its name', () => {
    expect(transferLabel({ manifest: { entries: [{ path: 'photo.jpg' }] } })).toBe('photo.jpg');
  });

  test('several flat files show first + count', () => {
    expect(transferLabel({ manifest: { entries: [{ path: 'a.jpg' }, { path: 'b.jpg' }] } })).toBe('a.jpg +1');
  });

  test('falls back to a peer id, then a generic word, never "Unknown peer"', () => {
    expect(transferLabel({ target: { id: '947 188 129' } })).toBe('947 188 129');
    expect(transferLabel({ peer: { id: 'dev-1' } })).toBe('dev-1');
    expect(transferLabel({})).toBe('files');
  });

  test('sourceRoots win over manifest when both are present (send is more accurate)', () => {
    expect(transferLabel({ sourceRoots: ['C:\\x\\Photos'], manifest: { entries: [{ path: 'Photos/a.jpg' }] } })).toBe('Photos');
  });
});
