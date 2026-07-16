// Composition root for the account server (vision §4.4). Pure wiring — reads
// env config, picks the email transport, opens the DB, and starts the HTTP
// server. All behaviour lives in the unit-tested modules; nothing here needs a
// test. Fails fast (non-zero exit) on invalid config.

import { dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { loadConfig } from './config.js';
import { createAccountServer } from './http/server.js';
import { createStdoutTransport, type EmailTransport } from './email.js';
import { createResendTransport } from './resend-transport.js';
import { createDiagnosticsStore } from './diagnostics-store.js';

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

  // Diagnostics bundles land in a `diagnostics/` subdir next to the SQLite DB
  // file (same data volume in prod). config.databaseUrl is a `file:` URL, e.g.
  // `file:/data/account.db` or `file:./account.db`.
  const dbPath = config.databaseUrl.replace(/^file:/, '');
  const dataDir = dirname(dbPath);
  // Guard against a non-numeric/negative env value (which Number() → NaN would
  // otherwise turn into a prune() that silently never deletes): fall back to 30d.
  const ttlDaysRaw = Number(process.env.ACCOUNT_DIAGNOSTICS_TTL_DAYS);
  const ttlDays = Number.isFinite(ttlDaysRaw) && ttlDaysRaw > 0 ? ttlDaysRaw : 30;
  const diagnostics = createDiagnosticsStore({
    dir: `${dataDir}/diagnostics`,
    fs: nodeFs,
    gzipSync,
    now: () => Date.now(),
    ttlMs: ttlDays * 86_400_000,
    randomId: () => randomBytes(4).toString('hex').toUpperCase(),
  });
  diagnostics.prune(); // startup sweep
  const pruneTimer = setInterval(() => diagnostics.prune(), 86_400_000);
  pruneTimer.unref(); // daily; never keeps the process alive on its own

  const server = createAccountServer({
    ctx: {
      prisma,
      email,
      secret: config.secret,
      baseUrl: config.baseUrl,
      now: () => Date.now(),
      diagnostics,
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
