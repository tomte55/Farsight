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
import { heartbeat, listFleet, type PresenceDeps } from '../presence.js';
import { setDevicePublicKey } from '../device-keys.js';
import { setTargetVersion } from '../device-update.js';
import { addContact, acceptContact, declineContact, listContacts } from '../contacts.js';

export interface ApiContext {
  prisma: PrismaClient;
  email: EmailTransport;
  secret: Uint8Array;
  baseUrl: string;
  now: () => number; // clock — called once per request
  diagnostics: { save(args: { userId: string; meta: unknown; files: Record<string, string> }): { id: string } };
}

export interface ApiRequest {
  method: string;
  path: string;
  body: unknown; // parsed JSON, or undefined
  query?: Record<string, string | undefined>; // parsed URL query string
  headers?: Record<string, string | string[] | undefined>;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  contentType?: string; // defaults to application/json; 'text/html' for web pages
}

const json = (status: number, body: unknown): ApiResponse => ({ status, body });
const ok = (body: unknown = { ok: true }): ApiResponse => json(200, body);
const badRequest = (error = 'invalid_request'): ApiResponse => json(400, { error });
const html = (status: number, body: string): ApiResponse => ({ status, body, contentType: 'text/html' });

// Pull a required non-empty string field from a JSON body, else undefined.
function str(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// Pull a required non-empty query-string param, else undefined.
function qstr(req: ApiRequest, key: string): string | undefined {
  const v = req.query?.[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// Minimal self-contained (no external assets) Farsight-branded HTML shell for the
// browser-facing verification / reset pages the emails link to.
function page(title: string, inner: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>` +
    `:root{color-scheme:dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
    `background:#0e0e16;color:#e6e6f0;font:15px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}` +
    `.card{width:min(92vw,420px);background:#16161f;border:1px solid #26263a;border-radius:14px;padding:30px 28px}` +
    `.brand{display:flex;align-items:center;gap:9px;margin-bottom:18px;font-weight:700}.glyph{color:#4aa8ff}` +
    `h1{font-size:18px;margin:0 0 8px}p{color:#a6a6c0;margin:0 0 14px}` +
    `label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#8a8aa8;margin:12px 0 5px}` +
    `input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:9px;border:1px solid #2c2c44;` +
    `background:#0e0e16;color:#e6e6f0;font-size:15px}button{width:100%;margin-top:16px;padding:11px;border:0;` +
    `border-radius:9px;background:#4aa8ff;color:#04122a;font-weight:700;font-size:15px;cursor:pointer}` +
    `.ok{color:#7ee0a0}.err{color:#ff8a8a}</style></head><body><div class="card">` +
    `<div class="brand"><span class="glyph">◆</span>Farsight</div>${inner}</div></body></html>`
  );
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
function presenceDeps(ctx: ApiContext): PresenceDeps {
  return { prisma: ctx.prisma, now: ctx.now() };
}
function contactsDeps(ctx: ApiContext): { prisma: PrismaClient; now: number } {
  return { prisma: ctx.prisma, now: ctx.now() };
}

const unauthorized = (): ApiResponse => json(401, { error: 'unauthorized' });

// Resolve the caller from a Bearer access token, enforcing the full session
// check (signature/expiry + tokenVersion + device revocation). Returns the
// caller's userId + deviceId, or a 401 response to short-circuit.
async function requireAuth(
  ctx: ApiContext,
  req: ApiRequest,
): Promise<{ userId: string; deviceId: string } | ApiResponse> {
  const header = req.headers?.['authorization'] ?? req.headers?.['Authorization'];
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer (.+)$/.exec(value ?? '');
  if (!match) return unauthorized();
  const res = await authenticate(sessionDeps(ctx), match[1]!);
  return res.ok ? { userId: res.userId, deviceId: res.deviceId } : unauthorized();
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

  // ── browser-facing web pages (the emails link to these GET routes) ────────
  'GET /verify': async (ctx, req) => {
    const token = qstr(req, 'token');
    if (!token) {
      return html(400, page('Verify email', `<h1>Verification link incomplete</h1><p>Open the link from your verification email again — it looks like part of it was cut off.</p>`));
    }
    const res = await verifyEmail(flowDeps(ctx), { token });
    if (res === 'ok') {
      return html(200, page('Email verified', `<h1 class="ok">Email verified ✓</h1><p>Your Farsight account is ready. Head back to the Farsight app and sign in.</p>`));
    }
    return html(400, page('Verify email', `<h1 class="err">Link invalid or expired</h1><p>This verification link is invalid or has expired. In the Farsight app, sign in to send yourself a fresh verification email.</p>`));
  },

  'GET /reset': async (ctx, req) => {
    const token = qstr(req, 'token');
    if (!token) {
      return html(400, page('Reset password', `<h1>Reset link incomplete</h1><p>Open the link from your password-reset email again — it looks like part of it was cut off.</p>`));
    }
    // Render the form; the token is validated (and consumed) on submit by
    // POST /confirm-password-reset, so a GET never burns the single-use link.
    const t = escapeHtml(token);
    const inner =
      `<h1>Choose a new password</h1><p>Enter a new password for your Farsight account.</p>` +
      `<form id="f"><input type="hidden" id="token" value="${t}">` +
      `<label for="pw">New password</label>` +
      `<input id="pw" type="password" autocomplete="new-password" minlength="8" required>` +
      `<button type="submit">Set new password</button></form><p id="msg"></p>` +
      `<script>document.getElementById('f').addEventListener('submit',async function(e){e.preventDefault();` +
      `var m=document.getElementById('msg');m.textContent='Saving…';m.className='';` +
      `var r=await fetch('/confirm-password-reset',{method:'POST',headers:{'content-type':'application/json'},` +
      `body:JSON.stringify({token:document.getElementById('token').value,newPassword:document.getElementById('pw').value})});` +
      `if(r.ok){m.textContent='Password updated — you can now sign in in the Farsight app.';m.className='ok';` +
      `document.getElementById('pw').disabled=true;e.target.querySelector('button').disabled=true;}` +
      `else{var d=await r.json().catch(function(){return{};});` +
      `m.textContent=d.error==='weak_password'?'Choose a stronger password (at least 8 characters).':` +
      `(d.error==='expired'?'This reset link has expired — request a new one from the app.':'This reset link is invalid or has already been used.');` +
      `m.className='err';}});</script>`;
    return html(200, page('Reset password', inner));
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

  // ── presence (S2.5): the device reports liveness; the owner lists the fleet ─
  'POST /devices/heartbeat': async (ctx, req) => {
    const auth = await requireAuth(ctx, req);
    if ('status' in auth) return auth;
    // The calling device reports its own liveness + optional current version +
    // its current signaling id (connect-from-console rendezvous).
    const version = str(req.body, 'version');
    const signalingId = str(req.body, 'signalingId');
    const { targetVersion } = await heartbeat(presenceDeps(ctx), { deviceId: auth.deviceId, version, signalingId });
    // Return any pending management directive (S2.7: converge-to target version).
    return ok({ targetVersion });
  },

  // Remote update (S2.7): the owner sets a target version for one of their own
  // devices; the host converges to the official feed on its next heartbeat. Pass
  // targetVersion:null (or omit) to clear.
  'POST /devices/update': async (ctx, req) => {
    const auth = await requireAuth(ctx, req);
    if ('status' in auth) return auth;
    const deviceId = str(req.body, 'deviceId');
    if (!deviceId) return badRequest();
    // Only your own devices — don't reveal whether someone else's id exists.
    const device = await ctx.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || device.userId !== auth.userId) return json(404, { error: 'not_found' });
    const targetVersion = str(req.body, 'targetVersion') ?? null;
    await setTargetVersion({ prisma: ctx.prisma }, { deviceId, targetVersion });
    return ok();
  },

  // Connect-from-console (SP2 §4.4): the calling device enrolls its account-issued
  // public key. Scoped to the caller's own deviceId (from the token) — you can only
  // set your own key.
  'POST /devices/key': async (ctx, req) => {
    const auth = await requireAuth(ctx, req);
    if ('status' in auth) return auth;
    const publicKey = str(req.body, 'publicKey');
    if (!publicKey) return badRequest();
    await setDevicePublicKey({ prisma: ctx.prisma }, { deviceId: auth.deviceId, publicKey });
    return ok();
  },

  'GET /devices': async (ctx, req) => {
    const auth = await requireAuth(ctx, req);
    if ('status' in auth) return auth;
    const devices = await listFleet(presenceDeps(ctx), { userId: auth.userId });
    return ok({ devices });
  },

  // ── contacts (SP3 §5.1): the in-app "friends list" ───────────────────────
  'POST /contacts/add': async (ctx, req) => {
    const auth = await requireAuth(ctx, req);
    if ('status' in auth) return auth;
    const email = str(req.body, 'email');
    if (!email) return badRequest();
    const inviter = await ctx.prisma.user.findUnique({ where: { id: auth.userId } });
    const res = await addContact(
      { prisma: ctx.prisma, now: ctx.now(), email: ctx.email, baseUrl: ctx.baseUrl, inviterEmail: inviter?.email },
      { requesterId: auth.userId, email },
    );
    if (res.ok) return ok({ contactId: res.contactId });
    // Authenticated route — surfacing no_such_user is an accepted trade-off (the UI
    // needs to tell the inviter "ask them to sign up first"); 'self' is a bad request.
    return res.reason === 'no_such_user' ? json(404, { error: 'no_such_user' }) : badRequest();
  },

  'POST /contacts/accept': async (ctx, req) => {
    const auth = await requireAuth(ctx, req);
    if ('status' in auth) return auth;
    const contactId = str(req.body, 'contactId');
    if (!contactId) return badRequest();
    const res = await acceptContact(contactsDeps(ctx), { userId: auth.userId, contactId });
    return res.ok ? ok() : json(404, { error: 'not_found' });
  },

  'POST /contacts/decline': async (ctx, req) => {
    const auth = await requireAuth(ctx, req);
    if ('status' in auth) return auth;
    const contactId = str(req.body, 'contactId');
    if (!contactId) return badRequest();
    const res = await declineContact(contactsDeps(ctx), { userId: auth.userId, contactId });
    return res.ok ? ok() : json(404, { error: 'not_found' });
  },

  'GET /contacts': async (ctx, req) => {
    const auth = await requireAuth(ctx, req);
    if ('status' in auth) return auth;
    return ok(await listContacts(contactsDeps(ctx), { userId: auth.userId }));
  },

  // Verbose diagnostic logging: an authenticated device/console uploads a
  // diagnostics bundle (logs + metadata). Persistence (disk, gzip, TTL prune)
  // is delegated to ctx.diagnostics — this handler only authenticates and
  // validates shape. The 5MB body-size cap for this route lives in the node
  // adapter (server.ts), not here.
  'POST /diagnostics': async (ctx, req) => {
    const auth = await requireAuth(ctx, req);
    if ('status' in auth) return auth;
    const body = (typeof req.body === 'object' && req.body) ? (req.body as Record<string, unknown>) : {};
    const files = body.files;
    if (typeof files !== 'object' || files === null) return badRequest();
    if (!Object.values(files as Record<string, unknown>).every((v) => typeof v === 'string')) return badRequest();
    const meta = typeof body.meta === 'object' && body.meta ? body.meta : {};
    const { id } = ctx.diagnostics.save({ userId: auth.userId, meta, files: files as Record<string, string> });
    return json(201, { id });
  },
};

export async function handleRequest(ctx: ApiContext, req: ApiRequest): Promise<ApiResponse> {
  const handler = handlers[`${req.method} ${req.path}`];
  if (!handler) return json(404, { error: 'not_found' });
  return handler(ctx, req);
}
