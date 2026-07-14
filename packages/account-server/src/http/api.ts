// Thin HTTP layer over the account flows (vision §4.4). Handlers are decoupled
// from node:http (ApiRequest → ApiResponse) so they're unit-testable without
// sockets; the node adapter + rate-limiting/logging wraps this separately. Raw
// routing (no web framework) keeps this internet-facing service's dependency
// surface minimal, consistent with the signaling server.

import type { PrismaClient } from '@prisma/client';
import type { EmailTransport } from '../email.js';
import type { FlowDeps } from '../flow-context.js';
import { registerUser, verifyEmail, resendVerification } from '../registration.js';
import { requestPasswordReset, confirmPasswordReset } from '../password-reset.js';
import { login, rotateSession, authenticate, revokeDevice, type SessionDeps } from '../session.js';
import {
  beginTotpEnrollment,
  confirmTotpEnrollment,
  disableTotp,
  type TwoFactorDeps,
} from '../two-factor.js';

export interface ApiContext {
  prisma: PrismaClient;
  email: EmailTransport;
  secret: Uint8Array;
  baseUrl: string;
  now: () => number; // clock — called once per request
}

export interface ApiRequest {
  method: string;
  path: string;
  body: unknown; // parsed JSON, or undefined
  headers?: Record<string, string | string[] | undefined>;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

const json = (status: number, body: unknown): ApiResponse => ({ status, body });
const ok = (body: unknown = { ok: true }): ApiResponse => json(200, body);
const badRequest = (error = 'invalid_request'): ApiResponse => json(400, { error });

// Pull a required non-empty string field from a JSON body, else undefined.
function str(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

type Handler = (ctx: ApiContext, req: ApiRequest) => Promise<ApiResponse>;

function flowDeps(ctx: ApiContext): FlowDeps {
  return { prisma: ctx.prisma, email: ctx.email, now: ctx.now(), baseUrl: ctx.baseUrl };
}
function sessionDeps(ctx: ApiContext): SessionDeps {
  return { prisma: ctx.prisma, secret: ctx.secret, now: ctx.now() };
}
function twoFactorDeps(ctx: ApiContext): TwoFactorDeps {
  return { prisma: ctx.prisma, now: ctx.now() };
}

const unauthorized = (): ApiResponse => json(401, { error: 'unauthorized' });

// Resolve the caller's account from a Bearer access token, enforcing the full
// session check (signature/expiry + tokenVersion + device revocation). Returns
// the userId, or a 401 response to short-circuit.
async function requireAuth(
  ctx: ApiContext,
  req: ApiRequest,
): Promise<{ userId: string } | ApiResponse> {
  const header = req.headers?.['authorization'] ?? req.headers?.['Authorization'];
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer (.+)$/.exec(value ?? '');
  if (!match) return unauthorized();
  const res = await authenticate(sessionDeps(ctx), match[1]!);
  return res.ok ? { userId: res.userId } : unauthorized();
}

const handlers: Record<string, Handler> = {
  'POST /register': async (ctx, req) => {
    const email = str(req.body, 'email');
    const password = str(req.body, 'password');
    if (!email || !password) return badRequest();
    const res = await registerUser(flowDeps(ctx), { email, password });
    if (res.ok) return json(201, { userId: res.userId });
    return res.reason === 'email_taken' ? json(409, { error: 'email_taken' }) : badRequest('weak_password');
  },

  'POST /verify-email': async (ctx, req) => {
    const token = str(req.body, 'token');
    if (!token) return badRequest();
    const res = await verifyEmail(flowDeps(ctx), { token });
    return res === 'ok' ? ok({ verified: true }) : badRequest(res); // 'invalid' | 'expired'
  },

  // Enumeration-safe: always 200, regardless of whether the email exists.
  'POST /resend-verification': async (ctx, req) => {
    const email = str(req.body, 'email');
    if (!email) return badRequest();
    await resendVerification(flowDeps(ctx), { email });
    return ok();
  },

  'POST /request-password-reset': async (ctx, req) => {
    const email = str(req.body, 'email');
    if (!email) return badRequest();
    await requestPasswordReset(flowDeps(ctx), { email });
    return ok();
  },

  'POST /confirm-password-reset': async (ctx, req) => {
    const token = str(req.body, 'token');
    const newPassword = str(req.body, 'newPassword');
    if (!token || !newPassword) return badRequest();
    const res = await confirmPasswordReset(flowDeps(ctx), { token, newPassword });
    return res.ok ? ok() : badRequest(res.reason); // 'invalid' | 'expired' | 'weak_password'
  },

  'POST /login': async (ctx, req) => {
    const email = str(req.body, 'email');
    const password = str(req.body, 'password');
    const deviceName = str(req.body, 'deviceName');
    const code = str(req.body, 'code'); // optional second factor
    if (!email || !password || !deviceName) return badRequest();
    const res = await login(sessionDeps(ctx), { email, password, deviceName, code });
    if (res.ok) {
      return ok({ accessToken: res.accessToken, refreshToken: res.refreshToken, deviceId: res.deviceId });
    }
    // 403 only for a verified-but-unverified-email account; everything else 401.
    const status = res.reason === 'email_unverified' ? 403 : 401;
    return json(status, { error: res.reason });
  },

  'POST /token/refresh': async (ctx, req) => {
    const refreshToken = str(req.body, 'refreshToken');
    if (!refreshToken) return badRequest();
    const res = await rotateSession(sessionDeps(ctx), refreshToken);
    return res.ok ? ok({ accessToken: res.accessToken }) : json(401, { error: res.reason });
  },

  // ── authenticated self-management (Bearer access token) ──────────────────
  'POST /2fa/begin': async (ctx, req) => {
    const auth = await requireAuth(ctx, req);
    if ('status' in auth) return auth;
    const { secret, otpauthUri } = await beginTotpEnrollment(twoFactorDeps(ctx), auth.userId);
    return ok({ secret, otpauthUri });
  },

  'POST /2fa/confirm': async (ctx, req) => {
    const auth = await requireAuth(ctx, req);
    if ('status' in auth) return auth;
    const code = str(req.body, 'code');
    if (!code) return badRequest();
    const res = await confirmTotpEnrollment(twoFactorDeps(ctx), auth.userId, code);
    return res.ok ? ok({ recoveryCodes: res.recoveryCodes }) : badRequest(res.reason);
  },

  'POST /2fa/disable': async (ctx, req) => {
    const auth = await requireAuth(ctx, req);
    if ('status' in auth) return auth;
    await disableTotp(twoFactorDeps(ctx), auth.userId);
    return ok();
  },

  'POST /devices/revoke': async (ctx, req) => {
    const auth = await requireAuth(ctx, req);
    if ('status' in auth) return auth;
    const deviceId = str(req.body, 'deviceId');
    if (!deviceId) return badRequest();
    // Only your own devices — don't reveal whether someone else's id exists.
    const device = await ctx.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || device.userId !== auth.userId) return json(404, { error: 'not_found' });
    await revokeDevice(sessionDeps(ctx), { deviceId });
    return ok();
  },
};

export async function handleRequest(ctx: ApiContext, req: ApiRequest): Promise<ApiResponse> {
  const handler = handlers[`${req.method} ${req.path}`];
  if (!handler) return json(404, { error: 'not_found' });
  return handler(ctx, req);
}
