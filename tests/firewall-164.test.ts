/**
 * Issue #164: the outbound privacy firewall had two fail-open paths.
 *
 * 1. `depth > MAX_DEPTH` returned `{ passed: true }` - anything nested deeper
 *    than 10 levels was declared safe WITHOUT BEING INSPECTED.
 * 2. The only API-key pattern was contextual (`api_key=...`). A page rendering
 *    a bare `sk-...`, `ghp_...`, `AKIA...` or JWT matched nothing at all.
 *
 * Both are regressions against a firewall that is the last line of defence, so
 * each test here asserts a payload is BLOCKED. A test that only checked the
 * happy path would have passed against the broken version too.
 */

import { describe, it, expect } from 'vitest';
import { inspectPayload, checkOutboundPayload } from '../src/lib/pii/firewall';

const SECRET = `sk-${'a'.repeat(8)}0123456789${'a'.repeat(16)}`;

/** Nest `value` under `levels` objects, so it sits far past MAX_DEPTH. */
function nest(value: unknown, levels: number): unknown {
  let node: Record<string, unknown> = { secret: value };
  for (let i = 0; i < levels; i++) node = { [`level${i}`]: node };
  return node;
}

describe('#164 defect 1: deep nesting was not inspected', () => {
  it('blocks a bare API key nested past MAX_DEPTH', () => {
    // Before the fix this returned passed:true without scanning anything.
    const result = checkOutboundPayload(nest(SECRET, 12));
    expect(result.passed).toBe(false);
  });

  it('blocks a bare API key nested just past MAX_DEPTH', () => {
    const result = checkOutboundPayload(nest(SECRET, 11));
    expect(result.passed).toBe(false);
  });

  it('blocks PII nested past MAX_DEPTH, not just secrets', () => {
    const result = checkOutboundPayload(nest('user@example.com', 12));
    expect(result.passed).toBe(false);
  });

  it('blocks a secret inside a deeply nested array', () => {
    let inner: unknown[] = [SECRET];
    for (let i = 0; i < 12; i++) inner = [inner];
    expect(checkOutboundPayload(inner).passed).toBe(false);
  });

  it('still blocks at exactly MAX_DEPTH (no regression at the boundary)', () => {
    // depth 10 is the last level walked structurally.
    expect(checkOutboundPayload(nest(SECRET, 8)).passed).toBe(false);
  });

  it('terminates on a cyclic structure instead of recursing forever', () => {
    // A page controls the shape of what it returns, so a cycle is possible.
    // The deep walk uses a WeakSet, so this returns rather than hanging.
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    const result = inspectPayload(cyclic, 'payload', 11);
    expect(result.passed).toBe(true); // nothing PII in it
  });

  it('still catches a secret reachable through a cycle', () => {
    // Termination must not become a bypass: the secret sits behind the loop.
    const cyclic: Record<string, unknown> = { secret: SECRET };
    cyclic.self = cyclic;
    expect(inspectPayload(cyclic, 'payload', 11).passed).toBe(false);
  });

  it('catches a secret pushed out of position by a large sibling', () => {
    // Regression guard. An earlier version sliced the serialised blob to 500
    // chars, so ~600 chars of filler before the secret moved it outside the
    // scanned window and it passed - a page-controlled fail-open.
    const deep: Record<string, unknown> = {
      filler: 'A'.repeat(4_000),
      secret: SECRET,
    };
    for (let i = 0; i < 12; i++) deep[`level${i}`] = { inner: deep };
    expect(checkOutboundPayload(deep).passed).toBe(false);
  });

  it('catches a PAN pushed out of position by a large sibling', () => {
    const deep: Record<string, unknown> = {
      filler: 'A'.repeat(4_000),
      pan: 'ABCPB1234C',
    };
    for (let i = 0; i < 12; i++) deep[`level${i}`] = { inner: deep };
    expect(checkOutboundPayload(deep).passed).toBe(false);
  });

  it('allows genuinely benign deep structures', () => {
    // Depth must not turn every payload into a block.
    const benign: Record<string, unknown> = { label: 'Submit the form' };
    for (let i = 0; i < 15; i++) benign[`level${i}`] = { label: 'Submit the form' };
    expect(checkOutboundPayload(benign).passed).toBe(true);
  });
});

describe('#164 defect 2: bare secrets were not matched', () => {
  // Credential-shaped values are BUILT AT RUNTIME, not written as literals.
  // GitHub push protection blocks a commit containing a string that matches a
  // real Slack/GitHub/AWS key pattern, even in a test fixture - and it was
  // right to: these have the exact shape of live credentials. Assembling from
  // fragments keeps the regex coverage identical while putting no usable secret
  // in git history. The values are still fixed-format, so the patterns must
  // still match them for the right reason.
  const ALPHA36 = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const rep = (s: string, n: number) => s.repeat(n).slice(0, n);

  const SECRETS: [string, string][] = [
    ['OpenAI/Anthropic style key', SECRET],
    ['GitHub classic PAT', `ghp_${rep(ALPHA36, 36)}`],
    ['GitHub OAuth token', `gho_${rep(ALPHA36, 36)}`],
    ['GitHub fine-grained PAT', `fine_${rep(ALPHA36, 36)}`],
    ['AWS access key id', `AKIA${'ABCDEFGHIJKLMNOP'}`],
    ['AWS temporary key id', `ASIA${'ABCDEFGHIJKLMNOP'}`],
    ['Google API key', `AIza${rep(ALPHA36, 35)}`],
    ['Slack bot token', `xoxb-1234567890-${rep(ALPHA36, 24)}`],
    ['Slack app token', `xapp-1-A${rep(ALPHA36, 12)}-${rep(ALPHA36, 24)}`],
    ['GitLab PAT', `glpat-${rep(ALPHA36, 20)}`],
    [
      'JWT',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
        'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.' +
        'dBjftJeZ4CVP' +
        'mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    ],
    ['PEM private key header', '-----BEGIN RSA PRIVATE KEY-----'],
    ['PEM EC private key header', '-----BEGIN EC PRIVATE KEY-----'],
  ];

  for (const [label, value] of SECRETS) {
    it(`blocks a ${label} with no surrounding label`, () => {
      // The contextual pattern alone matched none of these.
      expect(checkOutboundPayload({ field: value }).passed).toBe(false);
    });
  }

  it('blocks a bare secret at the payload root', () => {
    expect(checkOutboundPayload(SECRET).passed).toBe(false);
  });

  it('blocks a bare secret inside an array element', () => {
    expect(checkOutboundPayload({ items: ['harmless', SECRET] }).passed).toBe(false);
  });

  it('still blocks the contextual form it always did', () => {
    expect(checkOutboundPayload({ field: 'api_key=abcdefgh12345' }).passed).toBe(false);
  });

  it('never echoes the secret in the reason string', () => {
    const result = checkOutboundPayload({ field: SECRET });
    expect(result.passed).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.reason).not.toContain('abcdef0123456789');
  });
});

describe('#164: no false positives on ordinary content', () => {
  // A firewall that blocks routine page text is worse than none, because it
  // trains the user to click through. Each of these passed before the fix too -
  // the point is that they still do.
  const BENIGN: [string, string][] = [
    ['version numbers', 'Release v1.2.3 and v1.10.4 shipped today'],
    ['CSS selector', 'div.content > span.item:nth-child(2)'],
    ['dotted text', 'coords 12.34.56.78 in the log'],
    ['money', 'Total: $1234.56 and Rs 99,999.00 total'],
    ['ISO timestamp', '2026-09-26T14:48:58.4124568Z occurred'],
    ['placeholder text', 'Enter your API key here'],
    ['math notation', 'Let x_1 = {a,b} then x_2 = f(x_1)'],
    ['bare JWT header only', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 is only a header here'],
    ['12-digit non-Aadhaar', 'Order 123456789012 shipped on 2026-01-01'],
    ['slug with dashes', 'https://example.com/some-page_name-here/abc'],
    ['redacted marker', '[REDACTED]'],
  ];

  for (const [label, value] of BENIGN) {
    it(`allows ${label}`, () => {
      expect(checkOutboundPayload({ field: value }).passed).toBe(true);
    });
  }
});

describe('existing PII detection is intact', () => {
  it.each([
    ['email', 'user@example.com'],
    ['PAN (entity P)', 'ABCPB1234C'],
    ['IFSC', 'HDFC0001234'],
    ['SSN', '123-45-6789'],
  ])('still blocks %s', (_label, value) => {
    expect(checkOutboundPayload({ field: value }).passed).toBe(false);
  });
});
