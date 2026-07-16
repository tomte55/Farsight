// node:http adapter that turns the decoupled API handlers into a real listening
// server (vision §4.4). Internet-facing, so it is defensive: a request-body size
// cap, JSON-parse guarding, per-IP token-bucket rate limiting (reusing the
// signaling server's DoS pattern), a right-most X-Forwarded-For client IP behind
// a trusted proxy, single-line JSON logging of non-sensitive fields, and a
// catch-all that never leaks internals. All wiring — no business logic.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { handleRequest, type ApiContext } from './api.js';
import { createTokenBucket, type TokenBucket } from './token-bucket.js';

export interface CreateServerOptions {
  ctx: ApiContext;
  maxBodyBytes?: number; // reject bodies larger than this (default 64 KiB)
  diagnosticsMaxBodyBytes?: number; // larger cap for POST /diagnostics (default 5 MiB)
  rateLimit?: { capacity?: number; refillPerSec?: number };
  trustProxy?: boolean; // trust X-Forwarded-For (only behind our own proxy)
  log?: (event: string, fields: Record<string, unknown>) => void;
}

class PayloadTooLarge extends Error {}

// Right-most XFF entry is the one our single trusted proxy appended (the real
// client); the left-most is client-controlled and must never be trusted.
function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff.join(',') : xff;
    if (raw) {
      const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1]!;
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function readBody(req: IncomingMessage, cap: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > cap) return reject(new PayloadTooLarge());
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        reject(new PayloadTooLarge());
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createAccountServer(opts: CreateServerOptions): Server {
  const maxBodyBytes = opts.maxBodyBytes ?? 64 * 1024;
  const diagnosticsMaxBodyBytes = opts.diagnosticsMaxBodyBytes ?? 5 * 1024 * 1024;
  const trustProxy = opts.trustProxy ?? false;
  const log = opts.log ?? (() => {});
  const buckets = new Map<string, TokenBucket>();
  const bucketFor = (ip: string): TokenBucket => {
    let b = buckets.get(ip);
    if (!b) {
      b = createTokenBucket(opts.rateLimit);
      buckets.set(ip, b);
    }
    return b;
  };

  const send = (res: ServerResponse, status: number, body: unknown, contentType?: string) => {
    if (contentType === 'text/html') {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(String(body));
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const ip = clientIp(req, trustProxy);
    const url = req.url ?? '/';
    const qIdx = url.indexOf('?');
    const path = qIdx === -1 ? url : url.slice(0, qIdx);
    const query: Record<string, string> = {};
    if (qIdx !== -1) for (const [k, v] of new URLSearchParams(url.slice(qIdx + 1))) query[k] = v;
    try {
      if (!bucketFor(ip).tryRemove()) {
        log('rate_limited', { ip, path });
        return send(res, 429, { error: 'rate_limited' });
      }

      // The widened /diagnostics cap is only granted to a request that at least
      // carries an Authorization header — a purely-anonymous request keeps the
      // tight default cap, so it can't make us buffer 5 MiB before requireAuth
      // ever runs. Residual tradeoff: a BOGUS token still gets the wide cap, but
      // it's bounded by the per-IP rate limiter above and still 401s in the
      // handler — this deliberately blocks only anonymous amplification.
      const cap =
        path === '/diagnostics' && req.headers['authorization']
          ? diagnosticsMaxBodyBytes
          : maxBodyBytes;
      const rawBody = await readBody(req, cap);
      let body: unknown;
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          return send(res, 400, { error: 'invalid_json' });
        }
      }

      const response = await handleRequest(opts.ctx, {
        method: req.method ?? 'GET',
        path,
        body,
        query,
        headers: req.headers,
      });
      log('request', { ip, method: req.method, path, status: response.status });
      send(res, response.status, response.body, response.contentType);
    } catch (e) {
      if (e instanceof PayloadTooLarge) return send(res, 413, { error: 'payload_too_large' });
      log('error', { ip, path, message: e instanceof Error ? e.message : 'unknown' });
      send(res, 500, { error: 'internal' });
    }
  });
}
