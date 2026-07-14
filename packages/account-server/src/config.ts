// Env → typed config for the account server (vision §4.4). Internet-facing, so
// it fails fast on a missing/weak JWT signing secret rather than starting
// insecurely. Chooses the Resend transport when a key is present, else the
// stdout dev transport. Pure — no side effects, no process.env access here (the
// composition root passes env in), so it's fully unit-testable.

const DEFAULT_PORT = 8090; // signaling uses 8080; keep the sibling service distinct
const MIN_SECRET_BYTES = 32;

export type EmailConfig =
  | { kind: 'resend'; apiKey: string; from: string }
  | { kind: 'stdout' };

export interface AccountServerConfig {
  port: number;
  secret: Uint8Array;
  baseUrl: string;
  databaseUrl: string;
  email: EmailConfig;
  trustProxy: boolean;
}

function isTruthy(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

export function loadConfig(env: Record<string, string | undefined>): AccountServerConfig {
  const rawSecret = env.ACCOUNT_JWT_SECRET;
  if (!rawSecret) {
    throw new Error('ACCOUNT_JWT_SECRET is required (the JWT signing secret)');
  }
  const secret = new TextEncoder().encode(rawSecret);
  if (secret.length < MIN_SECRET_BYTES) {
    throw new Error(`ACCOUNT_JWT_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
  }

  const parsedPort = Number(env.PORT);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;

  let email: EmailConfig;
  if (env.RESEND_API_KEY) {
    if (!env.ACCOUNT_EMAIL_FROM) {
      throw new Error('ACCOUNT_EMAIL_FROM is required when RESEND_API_KEY is set');
    }
    email = { kind: 'resend', apiKey: env.RESEND_API_KEY, from: env.ACCOUNT_EMAIL_FROM };
  } else {
    email = { kind: 'stdout' };
  }

  return {
    port,
    secret,
    baseUrl: env.ACCOUNT_BASE_URL ?? `http://127.0.0.1:${port}`,
    databaseUrl: env.DATABASE_URL ?? 'file:./account.db',
    email,
    trustProxy: isTruthy(env.TRUST_PROXY),
  };
}
