// Real email delivery via Resend (vision §4.4 — Gusto's stack), behind the
// EmailTransport seam so the flows never know which transport is active. The
// API key is a deploy-time secret (env), never committed. fetch is injectable
// for tests.

import type { AccountEmail, EmailTransport } from './email.js';

export interface ResendConfig {
  apiKey: string;
  from: string; // e.g. "Farsight <no-reply@sovexa.org>"
  fetchImpl?: typeof fetch; // injectable; defaults to global fetch (Node 18+)
  endpoint?: string;
}

export function createResendTransport(config: ResendConfig): EmailTransport {
  const doFetch = config.fetchImpl ?? fetch;
  const endpoint = config.endpoint ?? 'https://api.resend.com/emails';

  return {
    async send(email: AccountEmail): Promise<void> {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: config.from,
          to: email.to,
          subject: email.subject,
          text: email.text,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`resend send failed: ${res.status} ${detail}`.trim());
      }
    },
  };
}
