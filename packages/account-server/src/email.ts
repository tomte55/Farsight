// Email delivery for account flows (SP2 §4.4). The flows build the message; a
// transport delivers it. This keeps the flows testable (a recording transport)
// and lets real delivery (Resend) be wired later behind the same interface with
// a no-op/stdout dev transport in between.

export interface AccountEmail {
  to: string;
  subject: string;
  text: string;
}

export interface EmailTransport {
  send(email: AccountEmail): Promise<void>;
}

// Dev transport: prints to stdout instead of sending. Never used in tests
// (which record into an array); the real Resend transport lands in a later slice.
export function createStdoutTransport(): EmailTransport {
  return {
    async send(email) {
      // eslint-disable-next-line no-console
      console.log(`[email] to=${email.to} subject=${email.subject}\n${email.text}`);
    },
  };
}

// Account emails are matched case-insensitively; store and look up the
// normalized form so "Dup@Example.com" and "dup@example.com" are one account.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
