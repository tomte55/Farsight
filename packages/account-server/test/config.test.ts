// Env → typed config for the account server (vision §4.4). Fail-fast on a
// missing/weak JWT secret; pick the Resend transport when a key is present, else
// the stdout dev transport. Pure parsing, unit-tested.

import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

const STRONG_SECRET = 'a-jwt-signing-secret-at-least-32-bytes-long';

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return { ACCOUNT_JWT_SECRET: STRONG_SECRET, ...overrides };
}

describe('loadConfig', () => {
  test('parses a full env with the Resend transport', () => {
    const cfg = loadConfig(
      baseEnv({
        PORT: '9001',
        ACCOUNT_BASE_URL: 'https://auth.sovexa.org',
        DATABASE_URL: 'file:/data/account.db',
        RESEND_API_KEY: 'rk_test',
        ACCOUNT_EMAIL_FROM: 'Farsight <no-reply@sovexa.org>',
        TRUST_PROXY: '1',
      }),
    );

    expect(cfg.port).toBe(9001);
    expect(cfg.baseUrl).toBe('https://auth.sovexa.org');
    expect(cfg.databaseUrl).toBe('file:/data/account.db');
    expect(cfg.trustProxy).toBe(true);
    expect(new TextDecoder().decode(cfg.secret)).toBe(STRONG_SECRET);
    expect(cfg.email).toEqual({ kind: 'resend', apiKey: 'rk_test', from: 'Farsight <no-reply@sovexa.org>' });
  });

  test('falls back to the stdout transport without a Resend key', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.email).toEqual({ kind: 'stdout' });
  });

  test('applies dev defaults for port / baseUrl / databaseUrl / trustProxy', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.port).toBe(8090);
    expect(cfg.baseUrl).toBe('http://127.0.0.1:8090');
    expect(cfg.databaseUrl).toBe('file:./account.db');
    expect(cfg.trustProxy).toBe(false);
  });

  test('throws when the JWT secret is missing or too short', () => {
    expect(() => loadConfig({})).toThrow(/ACCOUNT_JWT_SECRET/);
    expect(() => loadConfig({ ACCOUNT_JWT_SECRET: 'too-short' })).toThrow(/32/);
  });

  test('throws when a Resend key is set without a from-address', () => {
    expect(() => loadConfig(baseEnv({ RESEND_API_KEY: 'rk_test' }))).toThrow(/ACCOUNT_EMAIL_FROM/);
  });
});
