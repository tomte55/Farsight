// packages/account-server/src/password-policy.ts
// Ported ~verbatim from Gusto (github.com/tomte55/meal-planner) per vision §4.4.
// Pure, dependency-free — the account server's first brick (SP2, S2.1).

export type PasswordValidation =
  | { ok: true }
  | { ok: false; reason: 'too_short' | 'too_long' | 'too_simple' | 'breached' };

/**
 * Top ~100 most common breached passwords (8+ chars only, since shorter ones
 * are already rejected by the length check). Source: Have I Been Pwned / SecLists.
 * Checked case-insensitively.
 */
const BREACHED_PASSWORDS = new Set([
  'password',
  '12345678',
  '123456789',
  '1234567890',
  '12345678910',
  'password1',
  'password123',
  'qwerty123',
  'iloveyou',
  'princess',
  'sunshine',
  'football',
  'trustno1',
  'baseball',
  'whatever',
  'starwars',
  'passw0rd',
  'master12',
  'superman',
  'michael1',
  'shadow12',
  'monkey12',
  'dragon12',
  'qwertyui',
  'abc12345',
  'abcd1234',
  'abcdefgh',
  '12341234',
  'letmein1',
  'mustang1',
  'access14',
  'computer',
  'corvette',
  'jennifer',
  'midnight',
  'q1w2e3r4',
  'samantha',
  'steelers',
  'scoobydoo',
  'internet',
  'bigdaddy',
  'michelle',
  'cocacola',
  'nicholas',
  'jonathan',
  'test1234',
  'elephant',
  'victoria',
  'mercedes',
  'liverpoo',
  'liverpool',
  'maverick',
  'scorpion',
  'mountain',
  'december',
  'november',
  'pandora1',
  'lakers24',
  'changeme',
  '1q2w3e4r',
  '1q2w3e4r5t',
  '1qaz2wsx',
  'qwer1234',
  'asdf1234',
  'asdfghjk',
  'zxcvbnm1',
  'p@ssw0rd',
  'p@ssword',
  'pa$$word',
  'password!',
  'password12',
  'password1234',
  'welcome1',
  'welcome123',
  'master123',
  'qwerty12',
  'admin123',
  'admin1234',
  'letmein123',
  'monkey123',
  'dragon123',
  'shadow123',
  'michael123',
  'charlie1',
  'charlie123',
  'freedom1',
  'batman123',
  'jordan23',
  'jessica1',
  'chocolate',
  'chocolate1',
  'butterfly',
  'butterfly1',
  'babygirl1',
  'iloveyou1',
  'iloveyou2',
  'trustno12',
  'baseball1',
  'princess1',
  'sunshine1',
  'football1',
]);

export function validatePassword(password: string): PasswordValidation {
  if (password.length < 8) return { ok: false, reason: 'too_short' };
  // Upper bound caps argon2id hashing work per attempt (DoS guard). argon2 has
  // no bcrypt-style 72-byte truncation, but an unbounded input is still a cost
  // vector, so we keep Gusto's 200-char ceiling.
  if (password.length > 200) return { ok: false, reason: 'too_long' };
  // Reject passwords that are a single character repeated.
  if (new Set(password).size < 2) {
    return { ok: false, reason: 'too_simple' };
  }
  if (BREACHED_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false, reason: 'breached' };
  }
  return { ok: true };
}
