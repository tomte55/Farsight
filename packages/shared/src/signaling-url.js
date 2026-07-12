// packages/shared/src/signaling-url.js
export function assertSecureSignalingUrl(url) {
  const u = new URL(url);
  const localhost = ['localhost', '127.0.0.1', '::1', '[::1]'];
  if (u.protocol === 'wss:') return url;
  if (u.protocol === 'ws:' && localhost.includes(u.hostname)) return url;
  throw new Error('insecure signaling URL: wss:// required for non-localhost');
}
