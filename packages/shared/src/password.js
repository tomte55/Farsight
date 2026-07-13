// packages/shared/src/password.js
import { randomInt, timingSafeEqual } from 'node:crypto';

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'; // 31 unambiguous chars

export function generateSessionPassword() {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[randomInt(0, ALPHABET.length)];
  return s;
}

export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
