// tests/user-profile-egress.test.ts — issue #102: raw profile value must
// NEVER reach the outbound /plan payload (only the token + hints map).
import { describe, it, expect } from 'vitest';
import { guardOutboundPlan } from '../src/lib/pii/outboundGuard';
import { type UserProfile } from '../src/lib/userProfile';

const profile: UserProfile = {
  email: 'rajesh.kumar@test.com',
  address: '42 Market Road, Pune',
  phone: '+91 98765 43210',
};

describe('guardOutboundPlan with profile (issue #102)', () => {
  it('masks raw profile values in the task with stable tokens', () => {
    const r = guardOutboundPlan({
      task: 'Send my email to rajesh.kumar@test.com and ship to 42 Market Road, Pune',
      elements: [],
      profile,
    });
    expect(r.blocked).toBe(false);
    const task = r.payload.task as string;
    expect(task).toContain('<EMAIL>');
    expect(task).toContain('<ADDRESS>');
    // raw values are gone from the task
    expect(task).not.toContain('rajesh.kumar@test.com');
    expect(task).not.toContain('42 Market Road');
  });

  it('masks raw profile values inside element labels too', () => {
    const r = guardOutboundPlan({
      task: 'fill the form',
      elements: [{ label: 'contact rajesh.kumar@test.com now', name: 'email' }],
      profile,
    });
    const el = (r.payload.elements as Array<Record<string, unknown>>)[0];
    expect(el.label).toContain('<EMAIL>');
    expect(el.label).not.toContain('rajesh.kumar@test.com');
  });

  it('advertises a token-only profileHints map (no raw values)', () => {
    const r = guardOutboundPlan({ task: 'x', elements: [], profile });
    const hints = r.payload.profileHints as Record<string, string>;
    expect(hints).toEqual({
      email: '<EMAIL>',
      address: '<ADDRESS>',
      phone: '<PHONE>',
    });
    // no raw value anywhere in the whole serialized payload
    const flat = JSON.stringify(r.payload);
    expect(flat).not.toContain('rajesh.kumar@test.com');
    expect(flat).not.toContain('42 Market Road');
    expect(flat).not.toContain('98765');
  });

  it('behaves identically to before when no profile is given', () => {
    const r = guardOutboundPlan({ task: 'fill 9876543210', elements: [] });
    expect(r.payload.profileHints).toBeUndefined();
  });
});
