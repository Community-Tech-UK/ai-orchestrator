import { describe, expect, it } from 'vitest';
import {
  EFFORT_MAX_DESCRIPTION,
  EFFORT_WORKFLOW_DESCRIPTION,
  USAGE_CARD_TITLE,
  USAGE_CAUSE_COPY,
  USAGE_CAUSE_TOOLTIPS,
  USAGE_ESTIMATES_EXPLAINED,
  USAGE_OVERLAP_NOTE,
  USAGE_PROXY_NOTE,
  USAGE_UNSUPPORTED_TEXT,
  describeUsageCoverage,
  describeUsageNote,
  formatCauseShare,
} from './usage-cause-copy';
import { USAGE_CAUSE_IDS, type UsageInsightNote, type UsageInsightReport } from './usage-insight.types';

describe('cause copy', () => {
  it('covers all nine causes', () => {
    expect(Object.keys(USAGE_CAUSE_COPY).sort()).toEqual([...USAGE_CAUSE_IDS].sort());
  });

  it.each(USAGE_CAUSE_IDS)('%s has a title, one sentence and a measure', (id) => {
    const { title, sentence, measure } = USAGE_CAUSE_COPY[id];
    expect(title.length).toBeGreaterThan(0);
    expect(measure.length).toBeGreaterThan(0);
    // "One sentence": a single full stop, at the end.
    expect(sentence.endsWith('.')).toBe(true);
    expect(sentence.slice(0, -1)).not.toMatch(/[.!?]/);
    expect(sentence.length).toBeLessThanOrEqual(160);
  });

  it('uses plain words: no dashes used as punctuation, internal labels or old product names', () => {
    for (const text of [
      USAGE_CARD_TITLE,
      USAGE_OVERLAP_NOTE,
      USAGE_PROXY_NOTE,
      USAGE_ESTIMATES_EXPLAINED,
      ...Object.values(USAGE_CAUSE_COPY).flatMap((copy) => [copy.title, copy.sentence, copy.measure]),
    ]) {
      expect(text).not.toMatch(/[—–]/);
      expect(text).not.toMatch(/\bAIO\b|claude\.weekly|seven_day|cache_creation|IPC/);
    }
  });

  it('states the thresholds the measuring code uses', () => {
    expect(USAGE_CAUSE_COPY.cacheMiss.measure).toContain('100K');
    expect(USAGE_CAUSE_COPY.longContext.sentence).toContain('150K');
    expect(USAGE_CAUSE_COPY.longRunning.sentence).toContain('8 hours');
    expect(USAGE_CAUSE_COPY.alwaysOnContext.sentence).toContain('40K');
    expect(USAGE_CAUSE_COPY.bigToolResults.sentence).toContain('10K');
    expect(USAGE_CAUSE_COPY.parallelSessions.sentence).toContain('four or more');
  });

  it('says plainly where a measure is an estimate and how it was guessed', () => {
    expect(USAGE_CAUSE_COPY.parallelSessions.measure).toMatch(/estimate/i);
    expect(USAGE_CAUSE_COPY.parallelSessions.measure).toContain('five minutes');
    expect(USAGE_CAUSE_COPY.longRunning.measure).toMatch(/estimate/i);
    expect(USAGE_CAUSE_COPY.longRunning.measure).toContain('30 minutes');
    expect(USAGE_CAUSE_COPY.bigToolResults.measure).toMatch(/estimate/i);
    expect(USAGE_CAUSE_COPY.bigToolResults.measure).toContain('four characters');
  });

  it("doesn't call a measured cause an estimate", () => {
    for (const id of ['cacheMiss', 'longContext', 'helperHeavy', 'alwaysOnContext'] as const) {
      expect(USAGE_CAUSE_COPY[id].measure).not.toMatch(/estimate/i);
    }
  });
});

describe('what the shares are and are not', () => {
  it('says the shares overlap', () => {
    expect(USAGE_OVERLAP_NOTE).toBe("These overlap, so they don't add up to 100%.");
  });

  it("says the shares follow API prices and aren't how Anthropic counts the allowance", () => {
    expect(USAGE_PROXY_NOTE).toContain('API prices');
    expect(USAGE_PROXY_NOTE).toMatch(/isn't how Anthropic counts/);
  });

  it('explains each estimate in the same words as the limits the measuring code uses', () => {
    expect(USAGE_ESTIMATES_EXPLAINED).toContain('five minutes');
    expect(USAGE_ESTIMATES_EXPLAINED).toContain('30 minutes');
    expect(USAGE_ESTIMATES_EXPLAINED).toContain('four characters');
  });
});

describe('why a session cannot be broken down', () => {
  it('has a plain sentence for each reason, in contractions', () => {
    expect(USAGE_UNSUPPORTED_TEXT).toEqual({
      'not-claude': 'This breakdown is only available for Claude sessions.',
      'unknown-instance': "This session isn't open any more, so there's nothing to break down.",
      remote: "This session runs on another computer, so its Claude records aren't stored here.",
    });
  });
});

describe('tooltip copy for the controls beside these costs', () => {
  it("uses Anthropic's own words for the two effort levels, exactly", () => {
    expect(EFFORT_MAX_DESCRIPTION).toBe(
      'Thinks as long as it can on every step and uses much more of your allowance. Keep it for the hardest problems.',
    );
    expect(EFFORT_WORKFLOW_DESCRIPTION).toBe(
      'Splits every task across many helper agents; each one uses its own allowance.',
    );
  });

  it('reuses the cause sentences for the context ring and the helper controls', () => {
    expect(USAGE_CAUSE_TOOLTIPS.contextRing).toBe(USAGE_CAUSE_COPY.longContext.sentence);
    expect(USAGE_CAUSE_TOOLTIPS.contextRingIdle).toBe(USAGE_CAUSE_COPY.cacheMiss.sentence);
    expect(USAGE_CAUSE_TOOLTIPS.helperControls).toBe(USAGE_CAUSE_COPY.helperHeavy.sentence);
    expect(USAGE_CAUSE_TOOLTIPS.effortMax).toBe(EFFORT_MAX_DESCRIPTION);
    expect(USAGE_CAUSE_TOOLTIPS.effortWorkflow).toBe(EFFORT_WORKFLOW_DESCRIPTION);
  });
});

describe('formatCauseShare', () => {
  it('leads with the percentage and says what it is a share of', () => {
    expect(formatCauseShare(34, { kind: 'all' })).toBe('34% of your usage in the last 7 days');
    expect(formatCauseShare(34, { kind: 'session', instanceId: 'a' })).toBe("34% of this session's usage");
  });

  it('says "All" for a whole session and "At least" for a lower bound', () => {
    expect(formatCauseShare(100, { kind: 'session', instanceId: 'a' })).toBe("All of this session's usage");
    expect(formatCauseShare(100, { kind: 'session', instanceId: 'a' }, { atLeast: true })).toBe("At least 100% of this session's usage");
    expect(formatCauseShare(12, { kind: 'all' }, { atLeast: true })).toBe('At least 12% of your usage in the last 7 days');
  });

  it('marks an estimated share as an estimate, after the figure', () => {
    expect(formatCauseShare(23, { kind: 'all' }, { estimate: true })).toBe('23% of your usage in the last 7 days (estimate)');
    expect(formatCauseShare(23, { kind: 'session', instanceId: 'a' }, { estimate: true })).toBe("23% of this session's usage (estimate)");
    expect(formatCauseShare(100, { kind: 'session', instanceId: 'a' }, { estimate: true })).toBe("All of this session's usage (estimate)");
  });
});

describe('describeUsageNote', () => {
  const notes: UsageInsightNote[] = [
    { code: 'files-skipped-large', count: 1 },
    { code: 'files-skipped-large', count: 3 },
    { code: 'files-skipped-limit', count: 2 },
    { code: 'requests-trimmed', count: 12_345 },
    { code: 'lines-skipped', count: 1 },
    { code: 'lines-skipped', count: 7 },
    { code: 'files-unreadable', count: 1 },
    { code: 'files-unreadable', count: 4 },
    { code: 'cost-log-unreadable', count: 1 },
    { code: 'cost-log-unreadable', count: 3 },
    { code: 'session-links-unavailable' },
    { code: 'prices-approximate', count: 1 },
    { code: 'prices-approximate', count: 250 },
    { code: 'effort-partly-recorded', knownPercent: 40 },
    { code: 'no-claude-usage' },
  ];

  it.each(notes)('words $code in plain English', (note) => {
    const text = describeUsageNote(note);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/undefined|NaN|\[object/);
  });

  it('gets singular and plural right', () => {
    expect(describeUsageNote({ code: 'files-skipped-large', count: 1 })).toBe('1 very large transcript was left out to keep this quick.');
    expect(describeUsageNote({ code: 'files-skipped-large', count: 3 })).toBe('3 very large transcripts were left out to keep this quick.');
    expect(describeUsageNote({ code: 'files-skipped-limit', count: 2 })).toBe('2 older transcripts were left out because there was too much to read.');
    expect(describeUsageNote({ code: 'lines-skipped', count: 1 })).toBe('1 unreadable line was skipped.');
    expect(describeUsageNote({ code: 'files-unreadable', count: 1 })).toBe("1 transcript couldn't be read, so its usage is missing.");
    expect(describeUsageNote({ code: 'files-unreadable', count: 4 })).toBe("4 transcripts couldn't be read, so their usage is missing.");
    expect(describeUsageNote({ code: 'cost-log-unreadable', count: 1 })).toContain('1 day of');
    expect(describeUsageNote({ code: 'cost-log-unreadable', count: 3 })).toContain('3 days of');
  });

  it("uses contractions, like the rest of the card's words", () => {
    for (const note of notes) expect(describeUsageNote(note)).not.toMatch(/\b(could|did|does|do|is|are|was|were|has|have) not\b|\bcannot\b/);
  });

  it('says how much of the usage had a recorded effort setting', () => {
    expect(describeUsageNote({ code: 'effort-partly-recorded', knownPercent: 40 })).toContain('40%');
  });
});

describe('describeUsageCoverage', () => {
  function report(overrides: Partial<UsageInsightReport> = {}): UsageInsightReport {
    return {
      generatedAt: 1,
      windowStart: 0,
      windowEnd: 1,
      scope: { kind: 'all' },
      totals: { requests: 1_200, sessions: 14, harnessSessions: 14 },
      causes: [],
      coverage: { effortKnown: 1, harnessLinked: 1 },
      notes: [],
      ...overrides,
    };
  }

  it('says the figures only cover Claude sessions recorded on this computer, so other places are not assumed', () => {
    const text = describeUsageCoverage(report());
    expect(text).toContain('1,200 requests from 14 Claude sessions recorded on this computer');
    expect(text).toContain("Usage from other computers or the Claude apps isn't included.");
  });

  it('is silent about Harness when nearly all of the usage came from sessions Harness started', () => {
    expect(describeUsageCoverage(report({ coverage: { effortKnown: 1, harnessLinked: 0.96 } }))).not.toContain('Harness started');
  });

  it('says how little is known about the rest when much of it came from outside Harness', () => {
    const text = describeUsageCoverage(report({ coverage: { effortKnown: 0.4, harnessLinked: 0.4 } }));
    expect(text).toContain('Only 40% of this usage is from sessions Harness started');
    expect(text).toContain('effort and helper details are only known for those');
  });

  it('counts one session in the singular', () => {
    expect(describeUsageCoverage(report({ totals: { requests: 1, sessions: 1, harnessSessions: 1 } })))
      .toContain('1 request from 1 Claude session recorded on this computer');
  });

  it('describes a single session card by its own records, not by the share Harness started', () => {
    const text = describeUsageCoverage(report({
      scope: { kind: 'session', instanceId: 'a' },
      totals: { requests: 80, sessions: 1, harnessSessions: 1 },
      coverage: { effortKnown: 1, harnessLinked: 0.2 },
    }));
    expect(text).toBe("Counts the 80 requests recorded on this computer for this session, including helper agents working inside it. Usage from other computers or the Claude apps isn't included.");
    expect(text).not.toContain('Harness started');
  });
});
