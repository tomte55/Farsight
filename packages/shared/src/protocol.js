// packages/shared/src/protocol.js
export const MSG = Object.freeze({
  REGISTER: 'register',
  REGISTERED: 'registered',
  CONNECT: 'connect',
  OFFER: 'offer',
  ANSWER: 'answer',
  CANDIDATE: 'candidate',
  ICE_SERVERS: 'ice_servers',
  PEER_DISCONNECTED: 'peer_disconnected',
  UPDATE_PASSWORD: 'update_password',
  // SP3: dedicated file-transfer rendezvous (spec §4). A registered host is told a
  // transfer wants in (TRANSFER_REQUEST); its transfer worker joins by ATTACH.
  TRANSFER_REQUEST: 'transfer_request',
  ATTACH: 'attach',
  ERROR: 'error',
});

const KNOWN = new Set(Object.values(MSG));

export function buildMessage(type, payload = {}) {
  return { type, ...payload };
}

export function parseMessage(raw) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error('malformed message');
  }
  if (!obj || typeof obj.type !== 'string' || !KNOWN.has(obj.type)) {
    throw new Error('malformed message');
  }
  return obj;
}
