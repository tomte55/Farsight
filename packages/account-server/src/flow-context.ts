// Shared dependency bundle for the account flows (registration, verification,
// password reset). Injected rather than imported so the flows stay pure and
// unit-testable against a temp SQLite DB + a recording email transport.

import type { PrismaClient } from '@prisma/client';
import type { EmailTransport } from './email.js';

export interface FlowDeps {
  prisma: PrismaClient;
  email: EmailTransport;
  now: number; // epoch ms — injected for TTL + deterministic tests
  baseUrl: string; // where verify/reset links are hosted, e.g. https://auth.sovexa.org
}
