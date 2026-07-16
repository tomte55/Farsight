import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './helpers/test-db.js';
import type { AccountEmail, EmailTransport } from '../src/email.js';
import { handleRequest, type ApiContext, type ApiRequest } from '../src/http/api.js';

const SECRET = new TextEncoder().encode('contacts-secret-at-least-32-bytes-longgg');
const NOW = 1_700_000_000_000;
let db: TestDb;
let sent: AccountEmail[];

beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.cleanup(); });
afterEach(async () => {
  await db.prisma.contact.deleteMany();
  await db.prisma.device.deleteMany();
  await db.prisma.user.deleteMany();
  await db.prisma.emailVerification.deleteMany();
});

function ctx(): ApiContext {
  sent = [];
  const email: EmailTransport = { send: async (e) => void sent.push(e) };
  return { prisma: db.prisma, email, secret: SECRET, baseUrl: 'https://auth.example', now: () => NOW, diagnostics: { save: () => ({ id: 'stub' }) } };
}
const req = (method: string, path: string, body: unknown, token?: string): ApiRequest => ({
  method, path, body, headers: token ? { authorization: `Bearer ${token}` } : {},
});
async function loginToken(c: ApiContext, email: string): Promise<{ accessToken: string; deviceId: string }> {
  const before = sent.length;
  await handleRequest(c, req('POST', '/register', { email, password: 'a-good-passphrase' }));
  const token = sent[before]!.text.match(/token=([^\s&]+)/)![1]!;
  await handleRequest(c, req('POST', '/verify-email', { token }));
  const res = await handleRequest(c, req('POST', '/login', { email, password: 'a-good-passphrase', deviceName: 'pc' }));
  return res.body as { accessToken: string; deviceId: string };
}

describe('contacts HTTP', () => {
  test('all four routes require auth', async () => {
    const c = ctx();
    expect((await handleRequest(c, req('POST', '/contacts/add', { email: 'x@y.z' }))).status).toBe(401);
    expect((await handleRequest(c, req('POST', '/contacts/accept', { contactId: 'x' }))).status).toBe(401);
    expect((await handleRequest(c, req('POST', '/contacts/decline', { contactId: 'x' }))).status).toBe(401);
    expect((await handleRequest(c, req('GET', '/contacts', {}))).status).toBe(401);
  });

  test('add → 404 for unknown email, 200 for a real account', async () => {
    const c = ctx();
    const me = await loginToken(c, 'me@example.com');
    expect((await handleRequest(c, req('POST', '/contacts/add', { email: 'ghost@example.com' }, me.accessToken))).status).toBe(404);
    await loginToken(c, 'dad@example.com');
    const add = await handleRequest(c, req('POST', '/contacts/add', { email: 'dad@example.com' }, me.accessToken));
    expect(add.status).toBe(200);
    expect((add.body as any).contactId).toEqual(expect.any(String));
  });

  test('add missing email → 400', async () => {
    const c = ctx();
    const me = await loginToken(c, 'me@example.com');
    expect((await handleRequest(c, req('POST', '/contacts/add', {}, me.accessToken))).status).toBe(400);
  });

  test('full flow: add → dad sees incoming → dad accepts → me sees dad’s device', async () => {
    const c = ctx();
    const me = await loginToken(c, 'me@example.com');
    const dad = await loginToken(c, 'dad@example.com');
    // dad heartbeats so he has an online device with a signalingId
    await handleRequest(c, req('POST', '/devices/heartbeat', { signalingId: 'sig-DAD' }, dad.accessToken));

    const add = await handleRequest(c, req('POST', '/contacts/add', { email: 'dad@example.com' }, me.accessToken));
    const contactId = (add.body as any).contactId as string;

    const dadView = await handleRequest(c, req('GET', '/contacts', {}, dad.accessToken));
    expect((dadView.body as any).incoming).toEqual([{ contactId, email: 'me@example.com' }]);

    // a stranger cannot accept it
    const evil = await loginToken(c, 'evil@example.com');
    expect((await handleRequest(c, req('POST', '/contacts/accept', { contactId }, evil.accessToken))).status).toBe(404);

    expect((await handleRequest(c, req('POST', '/contacts/accept', { contactId }, dad.accessToken))).status).toBe(200);

    const meView = await handleRequest(c, req('GET', '/contacts', {}, me.accessToken));
    const accepted = (meView.body as any).accepted;
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ email: 'dad@example.com', signalingId: 'sig-DAD', online: true });
    expect(accepted[0].deviceId).toBe(dad.deviceId);
  });
});
