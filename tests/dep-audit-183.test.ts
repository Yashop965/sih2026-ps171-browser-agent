/**
 * #183 — the dependency tree stays audit-clean.
 *
 * The 11 findings this issue tracked were NOT fixed by upgrading `wxt`.
 * Every fix npm offered was a breaking major of the build tool itself, which
 * is a bad trade weeks from submission. They were fixed with `overrides` on
 * the leaf packages — the same lever #178 already used for `sharp`.
 *
 * This suite exists so the fix cannot silently rot:
 *   - the overrides stay in package.json (removing one reintroduces findings)
 *   - CI audits the FULL tree, not the production subset
 *   - `wxt` itself is NOT bumped, which is the thing this issue refused
 *
 * A dev-dependency advisory landing unnoticed is the failure mode that
 * mattered before: `sharp` is transitive to a PRODUCTION package, so
 * scoping the audit to `--omit=dev` would not even have caught it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as {
  overrides?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const ci = readFileSync('.github/workflows/ci.yml', 'utf-8');

describe('#183 the leaf overrides that cleared the audit are present', () => {
  const REQUIRED: Array<[string, string]> = [
    ['tar', '^7.5.22'],
    ['shell-quote', '^1.10.0'],
    ['tmp', '^0.2.7'],
    ['uuid', '^14.0.2'],
    ['adm-zip', '^0.6.1'],
  ];

  for (const [name, range] of REQUIRED) {
    it(`overrides ${name} to ${range}`, () => {
      // The vulnerable tar was 6.2.1 under giget; anything below 7.5.21
      // reintroduces the hardlink/symlink advisories.
      expect(pkg.overrides?.[name], `${name} override was removed`).toBe(range);
    });
  }

  it('keeps the pre-existing sharp override from #178', () => {
    expect(pkg.overrides?.sharp).toBe('^0.35.4');
  });
});

describe('#183 CI audits the full dependency tree', () => {
  it('does not scope the audit to a production subset', () => {
    // Scoping to the production subset is what let these sit unnoticed. It
    // also would not have caught `sharp`, which is transitive to a
    // PRODUCTION package via @huggingface/transformers.
    //
    // Scoped to `run:` lines on purpose: the comment block above the step
    // quotes the OLD `--production` flag when explaining the history, and a
    // bare substring search over the whole file would flag that history as
    // though the flag were still in use.
    const runLines = ci
      .split(/\r?\n/)
      .filter((l) => /^\s*run:/.test(l))
      .join('\n');
    expect(runLines).not.toMatch(/npm audit --omit=dev/);
    expect(runLines).not.toMatch(/npm audit --production/);
    expect(runLines).toMatch(/npm audit\s*$/m);
  });

  it('does not tolerate failures with || true', () => {
    // The original defect in this workflow: gates that printed a red result
    // and then discarded it.
    const auditStep = ci.slice(ci.indexOf('npm audit (full tree)'));
    expect(auditStep.slice(0, 200)).not.toMatch(/\|\|\s*true/);
  });

  it('every job still has its steps: key with real content under it', () => {
    // Editing this file by line-slicing can silently eat a structural key.
    // That is not hypothetical: an earlier revision of this change dropped
    // the security job's `steps:` line, and the file still contained the
    // audit command - so a substring test passed on a workflow GitHub
    // Actions would have refused to load.
    //
    // No YAML parser is available (and adding a dependency to assert one
    // test is not a trade worth making), so this walks the indentation
    // structure directly: inside the top-level `jobs:` block, every job key
    // must be followed by a `steps:` key before the next job.
    //
    // Scoped to the `jobs:` block on purpose. Matching 2-space keys across
    // the whole file also picks up the `on:` triggers (push, pull_request),
    // which are not jobs and have no steps.
    const lines = ci.split(/\r?\n/);
    const jobsStart = lines.findIndex((l) => /^jobs:$/.test(l));
    expect(jobsStart, 'no top-level jobs: key').toBeGreaterThan(-1);
    const body = lines.slice(jobsStart + 1);
    const jobs = body.map((l, i) => ({ l, i })).filter(({ l }) => /^ {2}[A-Za-z][\w-]*:$/.test(l));
    expect(jobs.length, 'no jobs found inside jobs:').toBeGreaterThan(0);
    for (const { i } of jobs) {
      const stepsIdx = body.findIndex((l, k) => k > i && /^ {4}steps:$/.test(l));
      const nextJob = body.findIndex((l, k) => k > i && /^ {2}[A-Za-z][\w-]*:$/.test(l));
      expect(stepsIdx, `job "${body[i].trim()}" has no steps:`).toBeGreaterThan(-1);
      expect(stepsIdx, `steps: of "${body[i].trim()}" sits past the next job`).toBeLessThan(
        nextJob === -1 ? body.length : nextJob
      );
      // and at least one actual step directly beneath it
      expect(
        body.some((l, k) => k > stepsIdx && /^ {4}- /.test(l)),
        `job "${body[i].trim()}" has an empty steps block`
      ).toBe(true);
    }
  });

  it('the audit step sits under a steps: block, not in a comment', () => {
    // Belt and braces on the same failure: the audit command exists in the
    // file AND is a live step, with no `#` in front of it.
    const lines = ci.split(/\r?\n/);
    const audits = lines.filter((l) => /\brun:\s*npm audit\s*$/.test(l));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.trim()).toBe('run: npm audit');
  });
});

describe('#183 the build tool was NOT upgraded to clear the audit', () => {
  it('stays on wxt ^0.19.0', () => {
    // Every audit fix npm offered was `fixAvailable: breaking` on wxt or one
    // of its pinned deps. Upgrading the build tool this close to submission
    // trades a dev-surface advisory for a real chance of breaking the build.
    expect(pkg.devDependencies?.wxt).toBe('^0.19.0');
  });

  it('documents that the overrides replaced the wxt upgrade', () => {
    // If someone later bumps wxt to satisfy the audit, this comment is the
    // record that the substitution was already considered and declined.
    //
    // Line-comment markers are stripped before matching. They are YAML
    // comments, not prose, and leaving them in inserts a stray `#` into the
    // middle of a wrapped sentence - so a rewrap, not a content change, would
    // fail the assertion.
    const flat = ci
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*#\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');
    expect(flat).toMatch(/not by upgrading `wxt`/);
    expect(flat).toMatch(/breaking major of the build tool itself/);
    expect(flat).toMatch(/`overrides` on the leaf packages/);
  });
});
