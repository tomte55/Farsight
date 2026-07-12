// packages/shared/src/turn.js
import { createHmac } from 'node:crypto';

export function makeTurnCredential({ secret, ttlSeconds, now = () => Date.now() }) {
  const expiry = Math.floor(now() / 1000) + ttlSeconds;
  const username = String(expiry);
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

export function buildIceServers({ turnUri, username, credential, stunUri }) {
  const servers = [];
  if (stunUri) servers.push({ urls: stunUri });
  if (turnUri) servers.push({ urls: turnUri, username, credential });
  return servers;
}
