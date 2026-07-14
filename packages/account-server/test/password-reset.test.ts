// S2.2 — password-reset flows (vision §4.4). Same one-time-token mechanism as
// email verification. A successful reset rotates the password, bumps
// tokenVersion (global session revocation), and proves email control (marks a
// still-unverified account verified). Tested against a temp SQLite DB.

import { afterAll, beforeAll, afterEach, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './helpers/test-db.js';
import { DEFAULT_TTL_MS } from '../src/one-time-token.js';
import { hashPassword, verifyPassword } from '../src/password-hash.js';
import type { AccountEmail, EmailTransport } from '../src/email.js';
import { requestPasswordReset, confirmPasswordReset, type FlowDeps } from '../src/password-reset.js';

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.cleanup();
});
afterEach(async () => {
  await db.prisma.passwordReset.deleteMany();
  await db.prisma.user.deleteMany();
});

function recordingTransport(): EmailTransport & { sent: AccountEmail[] } {
  const sent: AccountEmail[] = [];
  return { sent, send: async (e) => void sent.push(e) };
}
function tokenFrom(email: AccountEmail): string {
  const m = email.text.match(/token=([^\s&]+)/);
  if (!m) throw new Error(`no token in email: ${email.text}`);
  return m[1]!;
}
function deps(
  overrides: Partial<FlowDeps> = {},
): FlowDeps & { email: ReturnType<typeof recordingTransport> } {
  const email = (overrides.email as ReturnType<typeof recordingTransport>) ?? recordingTransport();
  return { prisma: db.prisma, now: 2_000_000, baseUrl: 'https://auth.example', ...overrides, email };
}

async function makeUser(email: string, password: string, verified = true) {
  return db.prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      emailVerifiedAt: verified ? new Date(1) : null,
    },
  });
}

describe('requestPasswordReset', () => {
  test('stores a reset token and emails it to a known user', async () => {
    const d = deps();
    await makeUser('r@example.com', 'original-pass');

    expect(await requestPasswordReset(d, { email: 'R@Example.com' })).toBe('sent');
    expect(d.email.sent).toHaveLength(1);
    expect(await db.prisma.passwordReset.count()).toBe(1);
  });

  test('is a no-op for an unknown email (no leak, no mail, no row)', async () => {
    const d = deps();
    expect(await requestPasswordReset(d, { email: 'nobody@example.com' })).toBe('noop');
    expect(d.email.sent).toHaveLength(0);
    expect(await db.prisma.passwordReset.count()).toBe(0);
  });

  test('invalidates a prior outstanding reset token', async () => {
    const d = deps();
    await makeUser('twice@example.com', 'original-pass');
    await requestPasswordReset(d, { email: 'twice@example.com' });
    const first = tokenFrom(d.email.sent[0]!);
    await requestPasswordReset(d, { email: 'twice@example.com' });

    expect(await db.prisma.passwordReset.count()).toBe(1); // only the latest survives
    expect((await confirmPasswordReset(d, { token: first, newPassword: 'brand-new-pass' })).ok).toBe(
      false,
    );
  });
});

describe('confirmPasswordReset', () => {
  test('rotates the password, bumps tokenVersion, and consumes the token', async () => {
    const d = deps();
    const user = await makeUser('c@example.com', 'original-pass');
    await requestPasswordReset(d, { email: 'c@example.com' });
    const raw = tokenFrom(d.email.sent[0]!);

    expect(await confirmPasswordReset(d, { token: raw, newPassword: 'a-brand-new-pass' })).toEqual({
      ok: true,
    });

    const updated = await db.prisma.user.findUnique({ where: { id: user.id } });
    expect(await verifyPassword(updated!.passwordHash, 'a-brand-new-pass')).toBe(true);
    expect(await verifyPassword(updated!.passwordHash, 'original-pass')).toBe(false);
    expect(updated!.tokenVersion).toBe(1); // revoke outstanding sessions
    expect(await db.prisma.passwordReset.count()).toBe(0); // single-use
  });

  test('rejects an unknown token', async () => {
    const d = deps();
    expect(await confirmPasswordReset(d, { token: 'nope', newPassword: 'a-brand-new-pass' })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  test('rejects an expired token without changing the password', async () => {
    const issued = deps({ now: 2_000_000 });
    const user = await makeUser('exp@example.com', 'original-pass');
    await requestPasswordReset(issued, { email: 'exp@example.com' });
    const raw = tokenFrom(issued.email.sent[0]!);

    const later = deps({ now: 2_000_000 + DEFAULT_TTL_MS + 1, email: issued.email });
    expect(await confirmPasswordReset(later, { token: raw, newPassword: 'a-brand-new-pass' })).toEqual({
      ok: false,
      reason: 'expired',
    });

    const unchanged = await db.prisma.user.findUnique({ where: { id: user.id } });
    expect(await verifyPassword(unchanged!.passwordHash, 'original-pass')).toBe(true);
  });

  test('rejects a weak new password and keeps the token usable', async () => {
    const d = deps();
    await makeUser('weak@example.com', 'original-pass');
    await requestPasswordReset(d, { email: 'weak@example.com' });
    const raw = tokenFrom(d.email.sent[0]!);

    expect(await confirmPasswordReset(d, { token: raw, newPassword: 'short' })).toEqual({
      ok: false,
      reason: 'weak_password',
    });
    expect(await db.prisma.passwordReset.count()).toBe(1); // not consumed — user can retry

    expect(await confirmPasswordReset(d, { token: raw, newPassword: 'a-brand-new-pass' })).toEqual({
      ok: true,
    });
  });

  test('marks a still-unverified account verified (reset proves email control)', async () => {
    const d = deps();
    const user = await makeUser('unv@example.com', 'original-pass', false);
    expect(user.emailVerifiedAt).toBeNull();

    await requestPasswordReset(d, { email: 'unv@example.com' });
    const raw = tokenFrom(d.email.sent[0]!);
    await confirmPasswordReset(d, { token: raw, newPassword: 'a-brand-new-pass' });

    const updated = await db.prisma.user.findUnique({ where: { id: user.id } });
    expect(updated!.emailVerifiedAt).toBeInstanceOf(Date);
  });
});
