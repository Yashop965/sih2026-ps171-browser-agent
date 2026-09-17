// tests/user-profile.test.ts — issue #102 local user profile
import { describe, it, expect } from 'vitest';
import {
  PROFILE_TOKENS,
  profileToken,
  keyForToken,
  maskProfileValues,
  profileHintsForPayload,
  resolveProfileValue,
  isProfileToken,
  type UserProfile,
} from '../src/lib/userProfile';

const P: UserProfile = {
  name: 'Rajesh Kumar',
  email: 'rajesh.kumar@test.com',
  phone: '+91 98765 43210',
  address: '42 Market Road, Pune',
  city: 'Pune',
};

describe('token helpers', () => {
  it('each key maps to a stable, opaque token', () => {
    expect(profileToken('email')).toBe('<EMAIL>');
    expect(keyForToken('<EMAIL>')).toBe('email');
    // tokens are round-trippable
    for (const k of Object.keys(PROFILE_TOKENS) as (keyof typeof PROFILE_TOKENS)[]) {
      expect(keyForToken(PROFILE_TOKENS[k])).toBe(k);
    }
  });
});

describe('maskProfileValues', () => {
  it('replaces a raw email in a task string with its token', () => {
    expect(maskProfileValues('email rajesh.kumar@test.com please', P)).toBe('email <EMAIL> please');
  });

  it('is idempotent - the token is not re-mapped', () => {
    const once = maskProfileValues('use <EMAIL> and rajesh.kumar@test.com', P);
    expect(once).toBe('use <EMAIL> and <EMAIL>');
    const twice = maskProfileValues(once, P);
    expect(twice).toBe(once);
  });

  it('longer values win when one contains the other (address over city)', () => {
    // "Pune" appears inside the address; masking must not turn the city into
    // the address token. Address (longer) is replaced first -> full value
    // becomes <ADDRESS>, so the bare "Pune" substring is gone.
    const out = maskProfileValues('ship to 42 Market Road, Pune and also Pune', P);
    expect(out).toBe('ship to <ADDRESS> and also <CITY>');
  });

  it('skips values shorter than 3 chars', () => {
    const p: UserProfile = { city: 'NY' };
    expect(maskProfileValues('live in NY now', p)).toBe('live in NY now');
  });

  it('leaves text with no profile values untouched', () => {
    expect(maskProfileValues('nothing personal here', P)).toBe('nothing personal here');
  });

  it('does not clobber a longer word that merely contains the value', () => {
    // "Pune" as a standalone word is masked; "Puneet" is not.
    const out = maskProfileValues('Pune vs Puneet', P);
    expect(out).toBe('<CITY> vs Puneet');
  });
});

describe('profileHintsForPayload', () => {
  it('emits a key->token map, omitting empty values', () => {
    const p: UserProfile = { email: 'a@b.c', city: '' };
    const hints = profileHintsForPayload(p);
    expect(hints).toEqual({ email: '<EMAIL>' });
  });

  it('never contains a raw value', () => {
    const hints = profileHintsForPayload(P);
    for (const v of Object.values(P)) {
      if (v) expect(JSON.stringify(hints)).not.toContain(v);
    }
  });
});

describe('resolveProfileValue', () => {
  it('resolves a token back to the stored value', () => {
    expect(resolveProfileValue('<EMAIL>', P)).toBe('rajesh.kumar@test.com');
    expect(resolveProfileValue('<PHONE>', P)).toBe('+91 98765 43210');
  });

  it('passes through non-token values unchanged', () => {
    expect(resolveProfileValue('just some text', P)).toBeUndefined();
    expect(resolveProfileValue(undefined, P)).toBeUndefined();
  });

  it('returns undefined for a token with no stored value', () => {
    expect(resolveProfileValue('<COMPANY>', P)).toBeUndefined();
  });
});

describe('isProfileToken', () => {
  it('is true only for known tokens', () => {
    expect(isProfileToken('<EMAIL>')).toBe(true);
    expect(isProfileToken('hello')).toBe(false);
    expect(isProfileToken(42)).toBe(false);
    expect(isProfileToken(null)).toBe(false);
  });
});
