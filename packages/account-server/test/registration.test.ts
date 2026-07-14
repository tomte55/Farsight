// S2.2 — registration + email verification flows over the Prisma models
// (vision §4.4). Flows are dependency-injected (prisma + email transport + a
// clock) and tested against a real throwaway SQLite DB with a recording email
// transport. The RAW verification token only ever leaves via email; the DB
// stores its hash.

import { afterAll, beforeAll, afterEach, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './helpers/test-db.js';
import { hashToken, DEFAULT_TTL_MS } from '../src/one-time-token.js';
import type { AccountEmail, EmailTransport } from '../src/email.js';
import {
  registerUser,
  verifyEmail,
  resendVerification,
  type FlowDeps,
} from '../src/registration.js';

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.cleanup();
});
afterEach(async () => {
  await db.prisma.emailVerification.deleteMany();
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
  return { prisma: db.prisma, now: 1_000_000, baseUrl: 'https://auth.example', ...overrides, email };
}

describe('registerUser', () => {
  test('creates an unverified user and emails a verification token (hash stored, not raw)', async () => {
    const d = deps();
    const res = await registerUser(d, { email: 'new@example.com', password: 'a-good-passphrase' });

    expect(res).toEqual({ ok: true, userId: expect.any(String) });

    const user = await db.prisma.user.findUnique({ where: { email: 'new@example.com' } });
    expect(user).not.toBeNull();
    expect(user!.emailVerifiedAt).toBeNull();

    expect(d.email.sent).toHaveLength(1);
    const raw = tokenFrom(d.email.sent[0]!);
    const row = await db.prisma.emailVerification.findFirst({ where: { userId: user!.id } });
    expect(row).not.toBeNull();
    expect(row!.tokenHash).toBe(hashToken(raw)); // stored value is the hash of the emailed token
    expect(row!.tokenHash).not.toBe(raw); // never the raw token
  });

  test('rejects a weak password without creating a user or sending mail', async () => {
    const d = deps();
    const res = await registerUser(d, { email: 'weak@example.com', password: 'short' });

    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe('weak_password');
    expect(await db.prisma.user.count()).toBe(0);
    expect(d.email.sent).toHaveLength(0);
  });

  test('rejects a duplicate email (case-insensitive) and stores email normalized', async () => {
    const d1 = deps();
    await registerUser(d1, { email: 'Dup@Example.com', password: 'a-good-passphrase' });
    expect(await db.prisma.user.findUnique({ where: { email: 'dup@example.com' } })).not.toBeNull();

    const d2 = deps();
    const res = await registerUser(d2, { email: 'DUP@example.COM', password: 'another-good-one' });
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe('email_taken');
    expect(await db.prisma.user.count()).toBe(1);
    expect(d2.email.sent).toHaveLength(0);
  });
});

describe('verifyEmail', () => {
  test('marks the user verified and consumes the token (single-use)', async () => {
    const d = deps();
    await registerUser(d, { email: 'v@example.com', password: 'a-good-passphrase' });
    const raw = tokenFrom(d.email.sent[0]!);

    expect(await verifyEmail(d, { token: raw })).toBe('ok');

    const user = await db.prisma.user.findUnique({ where: { email: 'v@example.com' } });
    expect(user!.emailVerifiedAt).toBeInstanceOf(Date);
    expect(await db.prisma.emailVerification.count()).toBe(0); // consumed

    expect(await verifyEmail(d, { token: raw })).toBe('invalid'); // not reusable
  });

  test('rejects an unknown token', async () => {
    const d = deps();
    await registerUser(d, { email: 'v2@example.com', password: 'a-good-passphrase' });
    expect(await verifyEmail(d, { token: 'not-a-real-token' })).toBe('invalid');
  });

  test('rejects an expired token and does not verify', async () => {
    const issued = deps({ now: 1_000_000 });
    await registerUser(issued, { email: 'exp@example.com', password: 'a-good-passphrase' });
    const raw = tokenFrom(issued.email.sent[0]!);

    const later = deps({ now: 1_000_000 + DEFAULT_TTL_MS + 1, email: issued.email });
    expect(await verifyEmail(later, { token: raw })).toBe('expired');

    const user = await db.prisma.user.findUnique({ where: { email: 'exp@example.com' } });
    expect(user!.emailVerifiedAt).toBeNull();
  });
});

describe('resendVerification', () => {
  test('invalidates the previous token and sends a fresh one', async () => {
    const d = deps();
    await registerUser(d, { email: 'resend@example.com', password: 'a-good-passphrase' });
    const first = tokenFrom(d.email.sent[0]!);

    expect(await resendVerification(d, { email: 'resend@example.com' })).toBe('sent');
    expect(d.email.sent).toHaveLength(2);
    const second = tokenFrom(d.email.sent[1]!);
    expect(second).not.toBe(first);

    expect(await verifyEmail(d, { token: first })).toBe('invalid'); // old link dead
    expect(await verifyEmail(d, { token: second })).toBe('ok');
  });

  test('is a no-op for an unknown or already-verified email (no leak, no mail)', async () => {
    const d = deps();
    expect(await resendVerification(d, { email: 'ghost@example.com' })).toBe('noop');
    expect(d.email.sent).toHaveLength(0);

    await registerUser(d, { email: 'done@example.com', password: 'a-good-passphrase' });
    const raw = tokenFrom(d.email.sent[0]!);
    await verifyEmail(d, { token: raw });
    d.email.sent.length = 0;

    expect(await resendVerification(d, { email: 'done@example.com' })).toBe('noop');
    expect(d.email.sent).toHaveLength(0);
  });
});
