// Composition root for the account server (vision §4.4). Pure wiring — reads
// env config, picks the email transport, opens the DB, and starts the HTTP
// server. All behaviour lives in the unit-tested modules; nothing here needs a
// test. Fails fast (non-zero exit) on invalid config.

import { PrismaClient } from '@prisma/client';
import { loadConfig } from './config.js';
import { createAccountServer } from './http/server.js';
import { createStdoutTransport, type EmailTransport } from './email.js';
import { createResendTransport } from './resend-transport.js';

function log(event: string, fields: Record<string, unknown> = {}): void {
  // Single-line JSON, non-sensitive fields only (matches the signaling server).
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

function main(): void {
  const config = loadConfig(process.env);

  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const email: EmailTransport =
    config.email.kind === 'resend'
      ? createResendTransport({ apiKey: config.email.apiKey, from: config.email.from })
      : createStdoutTransport();

  const server = createAccountServer({
    ctx: {
      prisma,
      email,
      secret: config.secret,
      baseUrl: config.baseUrl,
      now: () => Date.now(),
    },
    trustProxy: config.trustProxy,
    log,
  });

  server.listen(config.port, () => {
    log('listening', { port: config.port, email: config.email.kind, trustProxy: config.trustProxy });
  });

  const shutdown = (signal: string) => {
    log('shutdown', { signal });
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

try {
  main();
} catch (e) {
  log('fatal', { message: e instanceof Error ? e.message : 'unknown' });
  process.exit(1);
}
