/**
 * Completion evidence gate (agentRunner) — planner over-claim defense.
 *
 * The planner is told (prompt rule 16) to self-report checklist `done` flags,
 * and mergeChecklist ORs them in (sticky). A flaky model can assert "all done"
 * while sitting on the WRONG page (e.g. Special:Search) and the runner would
 * finish with no evidence the terminal goal was reached. The gate re-checks
 * the terminal sub-goal against the current page: it may only ADD a "keep
 * going" verdict, never a false completion.
 */
import { describe, it, expect } from 'vitest';
import {
  gateTerminalCompletion,
  terminalTargetSpans,
  isDestinationDescription,
} from '../src/lib/agentRunner';

const SEARCH_PAGE = {
  url: 'https://en.wikipedia.org/wiki/Special:Search',
  title: 'Search - Wikipedia',
};
const HYPERTEXT_PAGE = {
  url: 'https://en.wikipedia.org/wiki/Hypertext',
  title: 'Hypertext - Wikipedia',
};
const TIM_PAGE = {
  url: 'https://en.wikipedia.org/wiki/Tim_Berners-Lee',
  title: 'Tim Berners-Lee - Wikipedia',
};

describe('gateTerminalCompletion', () => {
  it('blocks a destination item whose target is not on the current page', () => {
    const v = gateTerminalCompletion({
      terminalItem: { id: '6', description: 'open the Hypertext article' },
      ...SEARCH_PAGE,
    });
    expect(v.block).toBe(true);
    expect(v.reason).toBe('destination-not-on-page');
  });

  it('lets a destination item pass when its target IS on the page', () => {
    const v = gateTerminalCompletion({
      terminalItem: { id: '6', description: 'open the Hypertext article' },
      ...HYPERTEXT_PAGE,
    });
    expect(v.block).toBe(false);
  });

  it('blocks a quoted target that is on a different page', () => {
    const v = gateTerminalCompletion({
      terminalItem: { id: '6', description: "open 'Tim Berners-Lee'" },
      ...SEARCH_PAGE,
    });
    expect(v.block).toBe(true);
  });

  it('lets a quoted target pass when it matches the current page', () => {
    const v = gateTerminalCompletion({
      terminalItem: { id: '5', description: "open 'Tim Berners-Lee'" },
      ...TIM_PAGE,
    });
    expect(v.block).toBe(false);
  });

  it('passes action goals (no destination wording) through even when the target words are absent', () => {
    // "fill the form and submit" names no page to land on; the URL/title
    // can't prove or disprove it, so it must not block completion.
    const v = gateTerminalCompletion({
      terminalItem: { id: '3', description: 'fill the form and submit it' },
      ...SEARCH_PAGE,
    });
    expect(v.block).toBe(false);
    expect(v.reason).toBe('action-goal-passed');
  });

  it('passes an empty description through (no checkable target)', () => {
    const v = gateTerminalCompletion({
      terminalItem: { id: '9' },
      ...SEARCH_PAGE,
    });
    expect(v.block).toBe(false);
    expect(v.reason).toBe('no-checkable-target');
  });

  it('blocks a destination whose target words are largely absent from the page', () => {
    // "read the progressive web app article" while on a totally unrelated page.
    const unrelated = {
      url: 'https://en.wikipedia.org/wiki/Cat',
      title: 'Cat - Wikipedia',
    };
    const v = gateTerminalCompletion({
      terminalItem: { id: '4', description: 'read the progressive web app article' },
      ...unrelated,
    });
    expect(v.block).toBe(true);
    expect(v.reason).toBe('destination-not-on-page');
  });
});

describe('terminalTargetSpans', () => {
  it('extracts quoted spans from a description', () => {
    expect(terminalTargetSpans("open 'Hypertext' article")).toEqual(['Hypertext']);
    expect(terminalTargetSpans('navigate to "Tim Berners-Lee"')).toEqual(['Tim Berners-Lee']);
    expect(terminalTargetSpans('fill the form')).toEqual([]);
  });
});

describe('isDestinationDescription', () => {
  it('detects destination phrasings', () => {
    expect(isDestinationDescription('open the Hypertext article')).toBe(true);
    expect(isDestinationDescription('navigate to Tim Berners-Lee')).toBe(true);
    expect(isDestinationDescription('look up Hypertext')).toBe(true);
  });
  it('does not detect pure action phrasings', () => {
    expect(isDestinationDescription('fill the form and submit it')).toBe(false);
    expect(isDestinationDescription('type your name into the box')).toBe(false);
  });
});
