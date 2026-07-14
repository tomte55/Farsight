// The controller's ./account.js re-exports the shared account service (moved to
// @farsight/shared/account-service so the host reuses one tested implementation).
// main.js imports from this local path, so guard that the re-export resolves.

import { describe, expect, test } from 'vitest';
import { createAccountService, DEFAULT_ACCOUNT_URL } from '../src/account.js';

describe('controller account re-export', () => {
  test('re-exports the shared account service + deployed default URL', () => {
    expect(typeof createAccountService).toBe('function');
    expect(DEFAULT_ACCOUNT_URL).toBe('https://auth.sovexa.org');
  });
});
