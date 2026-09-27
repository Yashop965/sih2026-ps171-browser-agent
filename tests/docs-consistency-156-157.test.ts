/**
 * #156 / #157 — the docs must not contradict each other, and must not
 * contradict the measured numbers.
 *
 * Both issues were filed because a reader (or an ISRO judge) could open the
 * README and find four different test counts in one document. That is a
 * credibility problem, and it recurs silently: nothing in CI looks at prose.
 *
 * This suite reads the docs and the measured facts, so the next drift is a
 * failing test rather than a stale sentence nobody notices for three weeks.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf-8');
const rootMd = () => readdirSync('.').filter((f) => f.endsWith('.md'));

/** The three files that are allowed to state current numbers. */
const CURRENT_STATE_DOCS = new Set(['README.md', 'QUICKSTART.md', 'TROUBLESHOOTING.md']);

describe('#157 every root doc that is a snapshot says so', () => {
  const snapshots = rootMd().filter((f) => !CURRENT_STATE_DOCS.has(f));

  it('found the root docs to check', () => {
    // If this ever hits zero the test is vacuous - which is exactly the
    // failure mode that lets a doc quietly become "current" again.
    expect(snapshots.length).toBeGreaterThan(0);
  });

  for (const f of snapshots) {
    it(`${f} carries a dated snapshot banner`, () => {
      const head = read(f).split(/\r?\n/).slice(0, 6).join('\n');
      expect(
        head,
        `${f} states test counts or a build size with no banner saying it is a ` +
          `historical snapshot - a reader will take it as current`
      ).toMatch(/snapshot|not current|as of 20/i);
    });
  }
});

describe('#156 the README states one set of numbers', () => {
  const readme = read('README.md');
  // Everything before the Timeline is current-state prose. The Timeline is
  // dated history and is ALLOWED to quote old figures - that is what a
  // timeline is for - so it is excluded rather than "fixed".
  const timelineAt = readme.search(/^## .*Timeline/m);
  expect(timelineAt, 'README no longer has a Timeline heading').toBeGreaterThan(0);
  const current = readme.slice(0, timelineAt);

  it('has no superseded test count in its current-state sections', () => {
    // Each of these was a real headline at some point. Seeing one again in
    // the current-state half means the README regressed to an old number.
    for (const stale of ['438', '524', '543', '421', '429']) {
      const asHeadline = new RegExp(`\\*\\*${stale}\\s*/\\s*${stale}`);
      expect(current, `README current-state still claims ${stale}/${stale}`).not.toMatch(
        asHeadline
      );
    }
  });

  it('quotes the same vitest count in the badge and the banner', () => {
    const badge = readme.match(/badge\/vitest-(\d+)%2F(\d+)/);
    const banner = readme.match(/\*\*(\d+)\/(\d+)\*\*\s*vitest/);
    expect(badge, 'vitest badge not found').toBeTruthy();
    expect(banner, 'vitest current-state banner not found').toBeTruthy();
    expect(banner![1], 'badge and banner disagree on the vitest total').toBe(badge![1]);
  });

  it('quotes the same pytest count in the badge and the banner', () => {
    const badge = readme.match(/badge\/pytest-(\d+)%2F(\d+)/);
    const banner = readme.match(/\*\*(\d+)\/(\d+)\*\*\s*pytest/);
    expect(badge, 'pytest badge not found').toBeTruthy();
    expect(banner, 'pytest current-state banner not found').toBeTruthy();
    expect(banner![1], 'badge and banner disagree on the pytest total').toBe(badge![1]);
  });

  it('states the build size once and does not also claim 1.33 MB', () => {
    expect(current, 'README current-state still claims a 1.33 MB build').not.toMatch(/1\.33 MB/);
    expect(readme, 'README no longer states a Chrome MV3 build size').toMatch(
      /Chrome MV3 build \*\*[\d.]+ MB\*\*/
    );
  });

  it('dates the current-state banner', () => {
    const m = readme.match(/Current state \(verified (\d{4}-\d{2}-\d{2})\)/);
    expect(m, 'README has no dated current-state banner').toBeTruthy();
  });
});

describe('#156 the coverage chart matches the headline it sits under', () => {
  it('the SVG no longer carries the superseded 438 count', () => {
    const svg = read('media/charts/tests-by-module.svg');
    expect(svg, 'chart still labelled with the old 438/438 run').not.toMatch(/438/);
  });

  it("the chart's own subtitle agrees with the README headline", () => {
    const readme = read('README.md');
    const headline = readme.match(/\*\*(\d+)\s*\/\s*\d+ passing\*\*\s*·\s*(\d+) files/);
    expect(headline, 'README health-table test row not found').toBeTruthy();
    const svg = read('media/charts/tests-by-module.svg');
    expect(svg).toContain(`${headline![1]}/${headline![1]}`);
    expect(svg).toContain(`${headline![2]} test files`);
  });

  it('the generator derives the subtitle instead of hardcoding it', () => {
    // The chart was stale precisely because the count was a literal in the
    // generator. If someone hardcodes a subtitle again, the next refresh
    // silently diverges from the README.
    const gen = read('scripts/generate_readme_charts.py');
    expect(gen, 'generator hardcodes a passing-count string again').not.toMatch(
      /"\d+\/\d+ passing/
    );
    expect(gen).toMatch(/f"\{TOTAL\}\/\{TOTAL\} passing/);
  });
});

describe('#157 no agent scratch files are tracked at the root', () => {
  it('.tmp_pr_review_40.md is gone and the pattern is ignored', () => {
    expect(existsSync('.tmp_pr_review_40.md')).toBe(false);
    expect(read('.gitignore')).toMatch(/\.tmp_pr_review_\*\.md/);
  });
});
