import { expect, test } from 'vitest';
import { UPDATE_STATUS, updateUiState, canInstallNow } from '../src/update-policy.js';

test('downloaded + idle → restart prompt', () => {
  const s = updateUiState({ status: 'downloaded', sessionActive: false, version: '1.2.0', downloaded: true });
  expect(s.showRestartPrompt).toBe(true);
  expect(s.checking).toBe(false);
  expect(s.version).toBe('1.2.0');
  expect(s.message).toBe('Update 1.2.0 ready to install.');
});

test('downloaded + active session → NO prompt, deferred message', () => {
  const s = updateUiState({ status: 'downloaded', sessionActive: true, version: '1.2.0', downloaded: true });
  expect(s.showRestartPrompt).toBe(false);
  expect(s.message).toBe('Update 1.2.0 will install after this session.');
});

test('checking / downloading / error / idle produce status only, never a prompt', () => {
  expect(updateUiState({ status: 'checking', sessionActive: false })).toMatchObject({ showRestartPrompt: false, checking: true, message: 'Checking for updates…' });
  expect(updateUiState({ status: 'downloading', sessionActive: false })).toMatchObject({ showRestartPrompt: false, message: 'Downloading update…' });
  expect(updateUiState({ status: 'error', sessionActive: false })).toMatchObject({ showRestartPrompt: false, message: "Couldn't check for updates." });
  expect(updateUiState({ status: 'idle', sessionActive: false })).toMatchObject({ showRestartPrompt: false, message: 'Up to date.' });
});

test('available (not yet downloaded) → status message, never a prompt', () => {
  const s = updateUiState({ status: 'available', sessionActive: false, version: '2.0.0' });
  expect(s.showRestartPrompt).toBe(false);
  expect(s.message).toBe('Update 2.0.0 available…');
});

test('version defaults to null when absent', () => {
  expect(updateUiState({ status: 'idle', sessionActive: false }).version).toBe(null);
});

test('canInstallNow: only when downloaded AND not in a session', () => {
  expect(canInstallNow({ downloaded: true, sessionActive: false })).toBe(true);
  expect(canInstallNow({ downloaded: true, sessionActive: true })).toBe(false);
  expect(canInstallNow({ downloaded: false, sessionActive: false })).toBe(false);
});

test('UPDATE_STATUS enumerates the states', () => {
  expect(UPDATE_STATUS.DOWNLOADED).toBe('downloaded');
});
