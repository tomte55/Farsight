import { describe, it, expect } from 'vitest';
import { validatePassword } from '../src/password-policy.js';

// Ported ~verbatim from Gusto (github.com/tomte55/meal-planner lib/password-policy.ts),
// per vision §4.4. Behaviour is identical; only the length-bound rationale is
// re-stated for argon2id (Farsight) instead of bcrypt (Gusto).
describe('validatePassword', () => {
  it('rejects empty', () => {
    expect(validatePassword('')).toEqual({ ok: false, reason: 'too_short' });
  });

  it('rejects < 8 characters', () => {
    expect(validatePassword('abc123')).toEqual({ ok: false, reason: 'too_short' });
  });

  it('rejects all-same-character passwords', () => {
    expect(validatePassword('aaaaaaaa')).toEqual({ ok: false, reason: 'too_simple' });
    expect(validatePassword('11111111')).toEqual({ ok: false, reason: 'too_simple' });
  });

  it('rejects > 200 characters (hashing-cost / DoS bound)', () => {
    expect(validatePassword('a'.repeat(201))).toEqual({ ok: false, reason: 'too_long' });
  });

  it('rejects common breached passwords', () => {
    expect(validatePassword('password')).toEqual({ ok: false, reason: 'breached' });
    expect(validatePassword('12345678')).toEqual({ ok: false, reason: 'breached' });
    expect(validatePassword('qwerty123')).toEqual({ ok: false, reason: 'breached' });
    expect(validatePassword('iloveyou')).toEqual({ ok: false, reason: 'breached' });
  });

  it('rejects breached passwords case-insensitively', () => {
    expect(validatePassword('PASSWORD')).toEqual({ ok: false, reason: 'breached' });
    expect(validatePassword('Password1')).toEqual({ ok: false, reason: 'breached' });
    expect(validatePassword('QWERTY123')).toEqual({ ok: false, reason: 'breached' });
  });

  it('accepts a reasonable password', () => {
    expect(validatePassword('correct horse battery')).toEqual({ ok: true });
  });
});
