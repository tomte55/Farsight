// Browser-facing web pages (SP2). Verification + password-reset emails link to
// GET /verify?token=… and GET /reset?token=… — a person clicks them in a mail
// client, so these must be real GET routes that render HTML (not the JSON API).
// Without them, register→verify→login is dead-on-arrival for every new user.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './helpers/test-db.js';
import type { AccountEmail, EmailTransport } from '../src/email.js';
import { handleRequest, type ApiContext } from '../src/http/api.js';

const SECRET = new TextEncoder().encode('http-secret-at-least-32-bytes-longgggggg');
const NOW = 1_700_000_000_000;

let db: TestDb;
let sent: AccountEmail[];

beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.cleanup(); });
afterEach(async () => {
  await db.prisma.emailVerification.deleteMany();
  await db.prisma.passwordReset.deleteMany();
  await db.prisma.user.deleteMany();
});

function ctx(): ApiContext {
  sent = [];
  const email: EmailTransport = { send: async (e) => void sent.push(e) };
  return { prisma: db.prisma, email, secret: SECRET, baseUrl: 'https://auth.example', now: () => NOW, diagnostics: { save: () => ({ id: 'stub' }) } };
}
const tokenFrom = (e: AccountEmail) => e.text.match(/token=([^\s&]+)/)![1]!;
const get = (path: string, query?: Record<string, string>) => ({ method: 'GET', path, query, body: undefined });

describe('GET /verify (email verification landing page)', () => {
  test('verifies the account and returns a success HTML page', async () => {
    const c = ctx();
    await handleRequest(c, { method: 'POST', path: '/register', body: { email: 'a@b.c', password: 'correcthorsebattery' } });
    const token = tokenFrom(sent[0]!);

    const res = await handleRequest(c, get('/verify', { token }));

    expect(res.status).toBe(200);
    expect(res.contentType).toBe('text/html');
    expect(String(res.body).toLowerCase()).toContain('verified');
    // the account is now verified — a subsequent login is allowed
    const user = await db.prisma.user.findUnique({ where: { email: 'a@b.c' } });
    expect(user?.emailVerifiedAt).not.toBeNull();
  });

  test('an invalid token returns an HTML error page (not a 200)', async () => {
    const res = await handleRequest(ctx(), get('/verify', { token: 'nope' }));
    expect(res.status).toBe(400);
    expect(res.contentType).toBe('text/html');
    expect(String(res.body).toLowerCase()).toMatch(/invalid|expired|couldn|could not/);
  });

  test('a missing token returns an HTML error page', async () => {
    const res = await handleRequest(ctx(), get('/verify'));
    expect(res.status).toBe(400);
    expect(res.contentType).toBe('text/html');
  });
});

describe('GET /reset (password-reset form page)', () => {
  test('renders a password form carrying the token', async () => {
    const c = ctx();
    await db.prisma.user.create({ data: { email: 'r@b.c', passwordHash: 'x', emailVerifiedAt: new Date(NOW) } });
    await handleRequest(c, { method: 'POST', path: '/request-password-reset', body: { email: 'r@b.c' } });
    const token = tokenFrom(sent[0]!);

    const res = await handleRequest(c, get('/reset', { token }));

    expect(res.status).toBe(200);
    expect(res.contentType).toBe('text/html');
    const html = String(res.body);
    expect(html).toContain(token);           // the form submits this token
    expect(html.toLowerCase()).toContain('password');
    expect(html).toContain('/confirm-password-reset'); // where the form posts
  });

  test('a missing token returns an HTML error page', async () => {
    const res = await handleRequest(ctx(), get('/reset'));
    expect(res.status).toBe(400);
    expect(res.contentType).toBe('text/html');
  });
});
