import { expect, test } from 'vitest';
import { UPDATE_STATUS, updateUiState, canInstallNow, shouldConverge } from '../src/update-policy.js';

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

test('checking / downloading / idle produce status only, never a prompt', () => {
  expect(updateUiState({ status: 'checking', sessionActive: false })).toMatchObject({ showRestartPrompt: false, checking: true, message: 'Checking for updates…' });
  expect(updateUiState({ status: 'downloading', sessionActive: false })).toMatchObject({ showRestartPrompt: false, message: 'Downloading update…' });
  expect(updateUiState({ status: 'idle', sessionActive: false })).toMatchObject({ showRestartPrompt: false, message: 'Up to date.' });
});

test('check-failure and download-failure carry distinct messages', () => {
  // The check itself failed (couldn't reach the feed).
  expect(updateUiState({ status: 'check-error', sessionActive: false }))
    .toMatchObject({ showRestartPrompt: false, message: "Couldn't check for updates." });
  // The check SUCCEEDED (an update was found) but the download failed.
  expect(updateUiState({ status: 'download-error', sessionActive: false, version: '2.0.0' }))
    .toMatchObject({ showRestartPrompt: false, message: 'Update 2.0.0 was found, but the download failed.' });
  // Download failure with no known version still reads sensibly.
  expect(updateUiState({ status: 'download-error', sessionActive: false }).message)
    .toBe('An update was found, but the download failed.');
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

test('shouldConverge only when the target is a newer version string', () => {
  expect(shouldConverge({ currentVersion: '1.7.0', targetVersion: '1.8.0' })).toBe(true);
  expect(shouldConverge({ currentVersion: '1.7.0', targetVersion: '1.7.0' })).toBe(false); // equal
  expect(shouldConverge({ currentVersion: '1.8.0', targetVersion: '1.7.0' })).toBe(false); // already newer
  expect(shouldConverge({ currentVersion: '1.7.0', targetVersion: null })).toBe(false);    // no directive
  expect(shouldConverge({ currentVersion: '1.7.0', targetVersion: '' })).toBe(false);
  expect(shouldConverge({ currentVersion: '', targetVersion: '1.8.0' })).toBe(false);      // unknown current
  expect(shouldConverge({})).toBe(false);
});
