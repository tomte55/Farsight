import { defineConfig, configDefaults } from 'vitest/config';

// The connection-auth handshake-pump tests (connection-auth.test.js and
// connection-auth-logging.test.js) crash/hang the tinypool worker on win32 with
// Node 24.x + vitest 2 — a pre-existing, environment-specific *runner* defect: the
// module and the handshake run fine in plain node, and the files pass in CI (Linux).
// Left unquarantined, a whole-suite `vitest run` here never exits and its worker
// pool pegs the CPU. Quarantine them ONLY on win32 so `vitest run`/`npm test` are
// safe on this dev box; CI still runs them for full coverage. Run directly if needed:
//   npx vitest run packages/shared/test/connection-auth.test.js   (may hang on win32)
const envExcludes = process.platform === 'win32' ? ['**/connection-auth*.test.js'] : [];

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.{js,ts}'],
    exclude: [...configDefaults.exclude, ...envExcludes],
    environment: 'node',
  },
});
