// S2.4 — 2FA enrollment/verify flows + login integration (vision §4.4). 2FA is
// optional per account and never required for management; when a user HAS
// enabled it, login requires a valid TOTP or recovery code. Tested against a
// temp SQLite DB.

import { afterAll, beforeAll, afterEach, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './helpers/test-db.js';
import { hashPassword } from '../src/password-hash.js';
import { base32Decode, totpCode } from '../src/totp.js';
import { login, type SessionDeps } from '../src/session.js';
import {
  beginTotpEnrollment,
  confirmTotpEnrollment,
  disableTotp,
  verifyTwoFactor,
  type TwoFactorDeps,
} from '../src/two-factor.js';

const SECRET = new TextEncoder().encode('twofa-secret-at-least-32-bytes-longgggg');
const NOW = 1_700_000_000_000;

let db: TestDb;
beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.cleanup();
});
afterEach(async () => {
  await db.prisma.recoveryCode.deleteMany();
  await db.prisma.device.deleteMany();
  await db.prisma.user.deleteMany();
});

function tfDeps(overrides: Partial<TwoFactorDeps> = {}): TwoFactorDeps {
  return { prisma: db.prisma, now: NOW, ...overrides };
}
function sessDeps(overrides: Partial<SessionDeps> = {}): SessionDeps {
  return { prisma: db.prisma, secret: SECRET, now: NOW, ...overrides };
}
async function makeUser(email: string) {
  return db.prisma.user.create({
    data: { email, passwordHash: await hashPassword('a-good-passphrase'), emailVerifiedAt: new Date(1) },
  });
}
// Enrol + confirm 2FA for a user; returns the recovery codes.
async function enable2fa(userId: string): Promise<string[]> {
  const { secret } = await beginTotpEnrollment(tfDeps(), userId);
  const code = totpCode(base32Decode(secret), NOW);
  const res = await confirmTotpEnrollment(tfDeps(), userId, code);
  if (!res.ok) throw new Error(`confirm failed: ${res.reason}`);
  return res.recoveryCodes;
}

describe('enrollment', () => {
  test('begin stages a secret + otpauth URI but does not enable 2FA yet', async () => {
    const user = await makeUser('e@example.com');
    const { secret, otpauthUri } = await beginTotpEnrollment(tfDeps(), user.id);

    expect(secret).toMatch(/^[A-Z2-7]+$/); // base32
    expect(otpauthUri).toContain('otpauth://totp/');
    expect(otpauthUri).toContain(`secret=${secret}`);

    const row = await db.prisma.user.findUnique({ where: { id: user.id } });
    expect(row!.totpSecret).toBe(secret);
    expect(row!.totpEnabledAt).toBeNull(); // not active until confirmed
  });

  test('confirm activates 2FA with a valid code and returns recovery codes', async () => {
    const user = await makeUser('c@example.com');
    const { secret } = await beginTotpEnrollment(tfDeps(), user.id);
    const res = await confirmTotpEnrollment(tfDeps(), user.id, totpCode(base32Decode(secret), NOW));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.recoveryCodes).toHaveLength(10);
    expect(await db.prisma.recoveryCode.count({ where: { userId: user.id } })).toBe(10);

    const row = await db.prisma.user.findUnique({ where: { id: user.id } });
    expect(row!.totpEnabledAt).toBeInstanceOf(Date);
  });

  test('confirm rejects a wrong code and leaves 2FA disabled', async () => {
    const user = await makeUser('bad@example.com');
    await beginTotpEnrollment(tfDeps(), user.id);
    const res = await confirmTotpEnrollment(tfDeps(), user.id, '000000');

    expect(res).toEqual({ ok: false, reason: 'invalid_code' });
    const row = await db.prisma.user.findUnique({ where: { id: user.id } });
    expect(row!.totpEnabledAt).toBeNull();
  });
});

describe('verifyTwoFactor', () => {
  test('accepts a current TOTP code', async () => {
    const user = await makeUser('v@example.com');
    const { secret } = await beginTotpEnrollment(tfDeps(), user.id);
    await confirmTotpEnrollment(tfDeps(), user.id, totpCode(base32Decode(secret), NOW));

    expect(await verifyTwoFactor(tfDeps(), user.id, totpCode(base32Decode(secret), NOW))).toBe('ok');
    expect(await verifyTwoFactor(tfDeps(), user.id, '000000')).toBe('invalid');
  });

  test('accepts a recovery code once, then never again (single-use)', async () => {
    const user = await makeUser('rec@example.com');
    const codes = await enable2fa(user.id);

    expect(await verifyTwoFactor(tfDeps(), user.id, codes[0]!)).toBe('ok');
    expect(await verifyTwoFactor(tfDeps(), user.id, codes[0]!)).toBe('invalid'); // consumed
    expect(await db.prisma.recoveryCode.count({ where: { userId: user.id, usedAt: null } })).toBe(9);
  });
});

describe('disableTotp', () => {
  test('clears the secret, the enabled flag, and the recovery codes', async () => {
    const user = await makeUser('d@example.com');
    await enable2fa(user.id);
    await disableTotp(tfDeps(), user.id);

    const row = await db.prisma.user.findUnique({ where: { id: user.id } });
    expect(row!.totpSecret).toBeNull();
    expect(row!.totpEnabledAt).toBeNull();
    expect(await db.prisma.recoveryCode.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe('login with 2FA enabled', () => {
  test('requires a code, rejects a wrong one, accepts a valid TOTP', async () => {
    const user = await makeUser('li@example.com');
    const { secret } = await beginTotpEnrollment(tfDeps(), user.id);
    await confirmTotpEnrollment(tfDeps(), user.id, totpCode(base32Decode(secret), NOW));

    const base = { email: 'li@example.com', password: 'a-good-passphrase', deviceName: 'x' };
    expect(await login(sessDeps(), base)).toEqual({ ok: false, reason: 'totp_required' });
    expect(await login(sessDeps(), { ...base, code: '000000' })).toEqual({
      ok: false,
      reason: 'totp_invalid',
    });

    const good = await login(sessDeps(), { ...base, code: totpCode(base32Decode(secret), NOW) });
    expect(good.ok).toBe(true);
  });

  test('a user without 2FA logs in without a code (unchanged path)', async () => {
    await makeUser('no2fa@example.com');
    const res = await login(sessDeps(), {
      email: 'no2fa@example.com',
      password: 'a-good-passphrase',
      deviceName: 'x',
    });
    expect(res.ok).toBe(true);
  });
});
