// Real email delivery via Resend, behind the EmailTransport seam (vision §4.4;
// Resend is Gusto's stack, key in hand). fetch is injected so this is fully
// unit-tested with no network.

import { describe, expect, test } from 'vitest';
import { createResendTransport } from '../src/resend-transport.js';

function fakeFetch(response: { ok: boolean; status: number; body?: string }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: response.ok,
      status: response.status,
      text: async () => response.body ?? '',
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('createResendTransport', () => {
  test('POSTs the message to Resend with Bearer auth and a JSON body', async () => {
    const { impl, calls } = fakeFetch({ ok: true, status: 200, body: '{"id":"abc"}' });
    const transport = createResendTransport({
      apiKey: 'test-key',
      from: 'Farsight <no-reply@sovexa.org>',
      fetchImpl: impl,
    });

    await transport.send({ to: 'user@example.com', subject: 'Verify', text: 'link' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-key');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      from: 'Farsight <no-reply@sovexa.org>',
      to: 'user@example.com',
      subject: 'Verify',
      text: 'link',
    });
  });

  test('throws with the status on a non-2xx response', async () => {
    const { impl } = fakeFetch({ ok: false, status: 422, body: 'bad from address' });
    const transport = createResendTransport({ apiKey: 'k', from: 'x', fetchImpl: impl });
    await expect(transport.send({ to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow(/422/);
  });
});
