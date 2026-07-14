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
import { login, rotateSession, type SessionDeps } from '../session.js';

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
};

export async function handleRequest(ctx: ApiContext, req: ApiRequest): Promise<ApiResponse> {
  const handler = handlers[`${req.method} ${req.path}`];
  if (!handler) return json(404, { error: 'not_found' });
  return handler(ctx, req);
}
