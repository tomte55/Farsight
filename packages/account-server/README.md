# @farsight/account-server

Self-hosted account/identity service for Farsight (SP2, vision §4.4) — the trust
root for a user's fleet. A sibling to the signaling server: **Node + TypeScript**,
**Prisma + SQLite**, **argon2id** hashing, **JWT** desktop tokens, optional
**TOTP 2FA**. Internet-facing → minimal dependencies and hardened, mirroring the
signaling server's posture.

> Status: the whole account/auth core is built and unit-tested; **not yet
> deployed**. Presence (S2.5), device enrollment (S2.6), and remote update (S2.7)
> build on this. See `docs/private/superpowers/farsight-vision.md`.

## What it does

- **Accounts** — registration, email verification, password reset (one-time
  tokens: raw token emailed, only its SHA-256 hash stored, 24h TTL, single-use,
  invalidated on resend). Password policy (length + breached-password blocklist).
- **Desktop sessions** — login issues a short-lived **access JWT** + long-lived
  **refresh JWT** (HS256), bound to a **Device** (the fleet unit) and the user's
  `tokenVersion`. Bumping `tokenVersion` (password change / sign-out-everywhere)
  or revoking a device invalidates its tokens immediately.
- **2FA (optional, never required for management)** — TOTP (RFC 6238) + one-time
  recovery codes; enforced at login only for accounts that opted in.

## HTTP API

Public:

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/register` | `{email, password}` → 201 `{userId}`; 409 taken; 400 weak/invalid |
| POST | `/verify-email` | `{token}` → 200; 400 invalid/expired |
| POST | `/resend-verification` | `{email}` → always 200 (enumeration-safe) |
| POST | `/request-password-reset` | `{email}` → always 200 (enumeration-safe) |
| POST | `/confirm-password-reset` | `{token, newPassword}` → 200; 400 |
| POST | `/login` | `{email, password, deviceName, code?}` → 200 `{accessToken, refreshToken, deviceId}`; 401; 403 unverified |
| POST | `/token/refresh` | `{refreshToken}` → 200 `{accessToken}`; 401 |

Authenticated (`Authorization: Bearer <accessToken>`):

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/2fa/begin` | → `{secret, otpauthUri}` (staged, not yet active) |
| POST | `/2fa/confirm` | `{code}` → `{recoveryCodes}` (activates 2FA) |
| POST | `/2fa/disable` | → 200 |
| POST | `/devices/revoke` | `{deviceId}` → 200 (own devices only; else 404) |

The node:http adapter adds a request-body size cap (413), JSON guard (400),
per-IP token-bucket rate limiting (429), right-most-`X-Forwarded-For` client IP
(behind a trusted proxy), single-line JSON logging, and a 500 catch-all.

## Develop

```sh
npm run prisma:generate -w @farsight/account-server   # once, and after schema changes
npx vitest run packages/account-server                # tests (temp-SQLite integration)
npm run typecheck -w @farsight/account-server
```

## Run

```sh
npm run build -w @farsight/account-server             # tsc → dist/
# apply the schema to the target DB (idempotent):
DATABASE_URL=file:./account.db npx prisma db push --skip-generate \
  --schema=packages/account-server/prisma/schema.prisma
ACCOUNT_JWT_SECRET=<32+ bytes> npm run start -w @farsight/account-server
```

Config is env-driven — see `.env.example`. Without `RESEND_API_KEY` the service
uses a stdout email transport (links are logged, not sent), so it runs fully
locally with no secrets beyond the JWT signing secret.
