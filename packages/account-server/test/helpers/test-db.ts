// Spin up a throwaway SQLite database with the Prisma schema applied, for
// integration tests. Each call creates a fresh temp DB and applies the schema
// via `prisma db push` (no migration files, no network) using the locally
// installed prisma CLI invoked through node — cross-platform, no shell.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const require = createRequire(import.meta.url);
const prismaCli = require.resolve('prisma'); // build/index.js — the CLI entry
const schemaPath = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));

export interface TestDb {
  prisma: PrismaClient;
  cleanup: () => Promise<void>;
}

export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-acct-'));
  const dbUrl = `file:${join(dir, 'test.db')}`;

  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--force-reset', `--schema=${schemaPath}`],
    { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'ignore' },
  );

  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  return {
    prisma,
    cleanup: async () => {
      await prisma.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
