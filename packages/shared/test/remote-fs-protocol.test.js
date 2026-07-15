import { expect, test } from 'vitest';
import {
  FS_OPS, FS_ENTRY_TYPES, isFsOp, validateFsReq, validateFsRes, validateDirEntry,
} from '../src/remote-fs-protocol.js';

test('op + entry-type sets are the full manager surface', () => {
  expect(FS_OPS).toEqual(['list', 'stat', 'mkdir', 'rename', 'move', 'delete']);
  expect(FS_ENTRY_TYPES).toEqual(['file', 'dir', 'symlink']);
  expect(isFsOp('delete')).toBe(true);
  expect(isFsOp('exec')).toBe(false);
});

test('validateFsReq enforces per-op args', () => {
  expect(validateFsReq({ reqId: 1, op: 'list', args: { path: 'C:/', cursor: null, limit: 100 } })).toBe(true);
  expect(validateFsReq({ reqId: 1, op: 'stat', args: { path: 'C:/x' } })).toBe(true);
  expect(validateFsReq({ reqId: 1, op: 'rename', args: { path: 'C:/x', newName: 'y' } })).toBe(true);
  expect(validateFsReq({ reqId: 1, op: 'move', args: { from: 'a', to: 'b' } })).toBe(true);
  expect(validateFsReq({ reqId: 1, op: 'delete', args: { path: 'a', recursive: true } })).toBe(true);
  // failures:
  expect(validateFsReq({ reqId: -1, op: 'stat', args: { path: 'x' } })).toBe(false);
  expect(validateFsReq({ reqId: 1, op: 'exec', args: {} })).toBe(false);
  expect(validateFsReq({ reqId: 1, op: 'list', args: { path: 'x', limit: 0 } })).toBe(false);
  expect(validateFsReq({ reqId: 1, op: 'rename', args: { path: 'x', newName: 'a/b' } })).toBe(false);
  expect(validateFsReq({ reqId: 1, op: 'delete', args: { path: 'a' } })).toBe(false);
});

test('validateFsRes requires an error code when not ok', () => {
  expect(validateFsRes({ reqId: 1, ok: true, data: { entries: [] } })).toBe(true);
  expect(validateFsRes({ reqId: 1, ok: false, error: { code: 'EACCES' } })).toBe(true);
  expect(validateFsRes({ reqId: 1, ok: false })).toBe(false);
  expect(validateFsRes({ reqId: 1, ok: 'yes' })).toBe(false);
});

test('validateDirEntry checks name/type/size/mtime', () => {
  expect(validateDirEntry({ name: 'a', type: 'file', size: 10, mtime: 1 })).toBe(true);
  expect(validateDirEntry({ name: 'd', type: 'dir', size: 0, mtime: 1 })).toBe(true);
  expect(validateDirEntry({ name: 'a', type: 'block', size: 0, mtime: 1 })).toBe(false);
  expect(validateDirEntry({ name: '', type: 'file', size: 0, mtime: 1 })).toBe(false);
});
