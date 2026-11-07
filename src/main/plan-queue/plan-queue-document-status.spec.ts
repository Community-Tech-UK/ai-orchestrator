import { describe, expect, it } from 'vitest';
import { closedIntegrationContent, closingWouldHideUnlandedWork, landedIntegrationStatus, otherUnlandedBranches, replaceOnMainLine } from './plan-queue-document-status';

const planWith = (status: string) => `# Plan\n## Status\nOn main: ${status}\nNext: review.\n`;
const quoted = (branch: string) => {
  const fence = '`'.repeat((branch.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0) + 1);
  return `${fence}${branch.startsWith('`') || branch.endsWith('`') ? ` ${branch} ` : branch}${fence}`;
};

describe('document integration status', () => {
  it.each(['topic/x,y', 'topic/x;y', 'topic/x)y', 'topic/x(y', 'topic/x`y', "topic/x'y", 'topic/x"y', '`topic/x', 'topic/x`'])('keeps the exact delimiter-bearing branch %s through a landing', branch => {
    const source = planWith(`no (${quoted(branch)}, ${quoted('topic/x')})`);
    expect(closingWouldHideUnlandedWork(source, branch)).toBe(true);
    const landed = replaceOnMainLine(source, landedIntegrationStatus(source, 'topic/x', 'abc123'));
    expect(closingWouldHideUnlandedWork(landed, branch)).toBe(false);
    expect(closingWouldHideUnlandedWork(landed, 'topic/x')).toBe(true);
    expect(landedIntegrationStatus(landed, branch, 'def456')).toBe('yes (def456)');
  });
  it.each([' ', ' ', ' ', ' ', ' ', ' ', '　', '﻿'])('keeps Git-valid Unicode whitespace U+%s in references', space => {
    for (const branch of [`topic/a${space}b`, `${space}topic/a`, `topic/a${space}`, `\`topic/a${space}`]) {
      const source = planWith(`no (${quoted(branch)}, ${quoted('topic/a')})`);
      const landed = replaceOnMainLine(source, landedIntegrationStatus(source, 'topic/a', 'abc123'));
      expect(closingWouldHideUnlandedWork(landed, branch)).toBe(false);
      expect(closingWouldHideUnlandedWork(landed, 'topic/a')).toBe(true);
      expect(landedIntegrationStatus(landed, branch, 'def456')).toBe('yes (def456)');
    }
  });
  it.each(['pending', 'unverified', 'blocked', 'not integrated', 'abcdef123'])('does not mistake parenthesised prose %s for a branch', word => {
    const source = planWith(`no (${word}).`);
    expect(closingWouldHideUnlandedWork(source, 'queue/current')).toBe(false);
    expect(landedIntegrationStatus(source, 'queue/current', 'abc123')).toBe('yes (abc123)');
  });
  it.each([
    'no, waiting on docs/plan.md review',
    'no (see docs/plans/other_plan.md; src/main/x.ts still open)',
    'no, release/notes pending and feature-flag work',
  ])('does not mistake a path or hyphenated words in "%s" for a branch', line => {
    const source = planWith(line);
    expect(otherUnlandedBranches(source, 'queue/current')).toEqual([]);
    expect(closingWouldHideUnlandedWork(source, 'queue/current')).toBe(false);
    expect(landedIntegrationStatus(source, 'queue/current', 'abc123')).toBe('yes (abc123)');
  });
  it.each(['pending', 'deadbeef', '1234', 'feature/pending', 'pending-work', 'topic/with+plus', 'équipe/travail'])('protects the backticked branch %s through another landing', branch => {
    const source = planWith(`no (${quoted(branch)})`);
    expect(closingWouldHideUnlandedWork(source, 'queue/current')).toBe(true);
    expect(otherUnlandedBranches(source, 'queue/current')).toEqual([branch]);
    const landed = landedIntegrationStatus(source, 'queue/current', 'abc123');
    expect(landed).toBe(`no (${quoted(branch)}); latest landed commit: abc123`);
    expect(closingWouldHideUnlandedWork(planWith(landed), 'queue/current')).toBe(true);
    expect(closingWouldHideUnlandedWork(source, branch)).toBe(false);
  });
  it.each(['queue/other', 'refs/heads/topic/x'])('recognises the unquoted queue-style branch %s and names it', branch => {
    const source = planWith(`no (${branch}).`);
    expect(otherUnlandedBranches(source, 'queue/current')).toEqual([branch]);
    expect(landedIntegrationStatus(source, 'queue/current', 'abc123')).toBe(`no (${branch}); latest landed commit: abc123`);
  });
  it('ignores ordinary Status prose and commit identifiers while retaining explicit branch references', () => {
    const source = '# Plan\n## Status\nOn main: no (not integrated; abcdef123).\nNext: review queue/other.\n';
    expect(closingWouldHideUnlandedWork(source, 'queue/current')).toBe(false);
    expect(closingWouldHideUnlandedWork(source.replace('(not integrated; abcdef123)', 'on `pending-work`'), 'queue/current')).toBe(true);
  });
  it('retains other unlanded branches when a job lands only its own work', () => {
    const source = planWith('no (queue/other, queue/current).');
    const landed = replaceOnMainLine(source, landedIntegrationStatus(source, 'queue/current', 'abc123'));
    expect(landed).toContain('On main: no (queue/other); latest landed commit: abc123');
    expect(closingWouldHideUnlandedWork(landed, 'queue/current')).toBe(true);
    expect(landedIntegrationStatus(landed, 'queue/other', 'def456')).toBe('yes (def456)');
  });
  it('rewrites only the first line of Status, preserving source content and later headings', () => {
    const source = '# Plan\n\n## Status\n\nNext: Step 8\n\n## Step 8\nKeep this.\n';
    const updated = replaceOnMainLine(source, 'yes (abc123)');
    expect(updated).toBe('# Plan\n\n## Status\n\nOn main: yes (abc123)\nNext: Step 8\n\n## Step 8\nKeep this.\n');
    expect(replaceOnMainLine(updated, 'no (queue/item)')).not.toContain('yes (abc123)');
    expect(replaceOnMainLine(updated, 'yes (abc123)')).toBe(updated);
  });

  it('refuses closure hiding another unlanded branch but permits this landing', () => {
    const source = '# Plan\n## Status\nOn main: no (`queue/other`).\nNext: retry.\n## Step 1\n';
    expect(closingWouldHideUnlandedWork(source, 'queue/item')).toBe(true);
    expect(closingWouldHideUnlandedWork(source, 'queue/other')).toBe(false);
    expect(closingWouldHideUnlandedWork(source.replace('no', 'yes'), 'queue/item')).toBe(false);
  });

  it.each(['## Status (7 Nov)', '## Status: nearly done', '## status'])('works under the heading "%s": reads the line, rewrites in place and closes', heading => {
    const source = `# Plan\n\n${heading}\n\nOn main: no (queue/other)\nNext: Step 8\n\n## Step 8\nKeep this.\n`;
    expect(otherUnlandedBranches(source, 'queue/item')).toEqual(['queue/other']);
    expect(closingWouldHideUnlandedWork(source, 'queue/item')).toBe(true);
    const updated = replaceOnMainLine(source, 'yes (abc123)');
    expect(updated).toBe(`# Plan\n\n${heading}\n\nOn main: yes (abc123)\nNext: Step 8\n\n## Step 8\nKeep this.\n`);
    expect(closedIntegrationContent(source, 'abc123')).toBe(updated);
    expect(updated.match(/^## Status/gim)).toHaveLength(1);
  });
  it('does not treat another heading that starts with Status as the Status block', () => {
    expect(otherUnlandedBranches('# Plan\n\n## Statusboard\nOn main: no (queue/x)\n', 'queue/item')).toEqual([]);
    expect(closedIntegrationContent('# Plan\n\n## Statusboard\nText\n')).toBe('# Plan\n\n## Statusboard\nText\n');
  });

  describe('locating the Status section', () => {
    it('keeps CRLF documents CRLF throughout, and still finds the section', () => {
      const source = '# Plan\r\n\r\n## Status (7 Nov)\r\n\r\nOn main: no (queue/other)\r\nNext: Step 8\r\n\r\n## Step 8\r\nKeep this.\r\n';
      expect(otherUnlandedBranches(source, 'queue/item')).toEqual(['queue/other']);
      const updated = replaceOnMainLine(source, 'yes (abc123)');
      expect(updated).toBe('# Plan\r\n\r\n## Status (7 Nov)\r\n\r\nOn main: yes (abc123)\r\nNext: Step 8\r\n\r\n## Step 8\r\nKeep this.\r\n');
      expect(updated.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
      const inserted = replaceOnMainLine('# Plan\r\n\r\nBody.\r\n', 'yes (abc123)');
      expect(inserted).toBe('# Plan\r\n\r\n## Status\r\n\r\nOn main: yes (abc123)\r\n\r\nBody.\r\n');
      expect(inserted.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    });

    it('ignores a fenced example heading before the real one, and a fenced "## " line inside the block', () => {
      const source = '# Plan\n\n```md\n## Status\nOn main: no (queue/fake)\n```\n\n## Status\n\nOn main: no (queue/real)\n```\n## Not a heading\n```\nNext: x\n\n## Step 1\n';
      expect(otherUnlandedBranches(source, 'queue/item')).toEqual(['queue/real']);
      const updated = replaceOnMainLine(source, 'yes (abc123)');
      expect(updated).toBe('# Plan\n\n```md\n## Status\nOn main: no (queue/fake)\n```\n\n## Status\n\nOn main: yes (abc123)\n```\n## Not a heading\n```\nNext: x\n\n## Step 1\n');
    });

    it('does not treat a Status heading that exists only inside a fence as a Status block', () => {
      const source = '# Plan\n\n```md\n## Status\nOn main: no (queue/fake)\n```\n';
      expect(otherUnlandedBranches(source, 'queue/item')).toEqual([]);
      expect(closedIntegrationContent(source)).toBe(source);
      expect(replaceOnMainLine(source, 'yes (abc)')).toBe('# Plan\n\n## Status\n\nOn main: yes (abc)\n\n```md\n## Status\nOn main: no (queue/fake)\n```\n');
    });

    it('updates a Status heading on the last line with no trailing newline', () => {
      expect(replaceOnMainLine('# Plan\n\n## Status', 'yes (abc123)')).toBe('# Plan\n\n## Status\n\nOn main: yes (abc123)');
      expect(replaceOnMainLine('# Plan\n\n## Status (now)', 'yes (abc123)')).toBe('# Plan\n\n## Status (now)\n\nOn main: yes (abc123)');
      expect(closedIntegrationContent('# Plan\n\n## Status', 'abc')).toBe('# Plan\n\n## Status\n\nOn main: yes (abc)');
    });

    it('adds a missing Status block after front matter and the title, never inside the front matter', () => {
      const source = '---\ntitle: x\nstatus: draft\n---\n\n# Plan\n\nBody.\n';
      expect(replaceOnMainLine(source, 'yes (abc)')).toBe('---\ntitle: x\nstatus: draft\n---\n\n# Plan\n\n## Status\n\nOn main: yes (abc)\n\nBody.\n');
      expect(replaceOnMainLine('---\ntitle: x\n---\nBody.\n', 'yes (abc)')).toBe('---\ntitle: x\n---\n\n## Status\n\nOn main: yes (abc)\n\nBody.\n');
      expect(replaceOnMainLine('# Plan\nBody.\n', 'yes (abc)')).toBe('# Plan\n\n## Status\n\nOn main: yes (abc)\n\nBody.\n');
    });

    it('treats an em-dash heading as the Status block, as the plan diet does', () => {
      const source = '# Plan\n\n## Status \u2014 7 Nov\n\nOn main: no (queue/other)\nNext: x\n\n## Step 1\n';
      expect(otherUnlandedBranches(source, 'queue/item')).toEqual(['queue/other']);
      expect(replaceOnMainLine(source, 'yes (abc)')).toBe('# Plan\n\n## Status \u2014 7 Nov\n\nOn main: yes (abc)\nNext: x\n\n## Step 1\n');
      expect(closedIntegrationContent('# Plan\n\n## Status \u2014 now\nText\n', 'abc').match(/^## Status/gm)).toHaveLength(1);
    });

    it('keeps the final newline when Status is the last section and holds only the On main line', () => {
      expect(replaceOnMainLine('# T\n\n## Status\n\nOn main: no\n', 'yes (x)')).toBe('# T\n\n## Status\n\nOn main: yes (x)\n');
      expect(replaceOnMainLine('# T\n\n## Status\n\nOn main: no', 'yes (x)')).toBe('# T\n\n## Status\n\nOn main: yes (x)');
      expect(replaceOnMainLine('# T\r\n\r\n## Status\r\n\r\nOn main: no\r\n', 'yes (x)')).toBe('# T\r\n\r\n## Status\r\n\r\nOn main: yes (x)\r\n');
    });

    it('keeps a blank line before the next heading when the block held only the On main line', () => {
      expect(replaceOnMainLine('# P\n\n## Status\n\nOn main: no (queue/a)\n\n## Step 1\n', 'yes (abc)')).toBe('# P\n\n## Status\n\nOn main: yes (abc)\n\n## Step 1\n');
    });
  });
});
