import { describe, expect, it } from 'vitest';

import { parseSkillFrontmatter, triggerMatchesText } from './skill.types';

describe('parseSkillFrontmatter', () => {
  it('parses YAML frontmatter values that contain colons', () => {
    const metadata = parseSkillFrontmatter(
      '---\nname: yaml-demo\ndescription: "Use when X: do Y"\ntriggers:\n  - alpha\n---\n# body\n',
    );

    expect(metadata?.description).toBe('Use when X: do Y');
  });

  it('parses quoted inline YAML arrays without splitting inside quoted values', () => {
    const metadata = parseSkillFrontmatter(
      '---\nname: yaml-demo\ndescription: Inline array\ntriggers: ["alpha, beta", gamma]\n---\n# body\n',
    );

    expect(metadata?.triggers).toEqual(['alpha, beta', 'gamma']);
  });

  it('preserves legacy preferred model aliases', () => {
    for (const field of ['preferred_model', 'model']) {
      const metadata = parseSkillFrontmatter(
        `---\nname: model-demo\ndescription: Uses an explicit model\ntriggers:\n  - alpha\n${field}: claude-opus-4-1\n---\n`,
      );

      expect(metadata?.preferredModel).toBe('claude-opus-4-1');
    }
  });
});

describe('triggerMatchesText', () => {
  it('matches phrase triggers only on word boundaries', () => {
    expect(triggerMatchesText('play api', 'use the play api for uploads')).toBe(true);
    expect(triggerMatchesText('play api', 'the display apique layout')).toBe(false);
    expect(triggerMatchesText('test', 'run the test suite')).toBe(true);
    expect(triggerMatchesText('test', 'the latest build')).toBe(false);
  });

  it('keeps substring semantics for slash-command triggers', () => {
    expect(triggerMatchesText('/ui-audit', 'run /ui-audit on the page')).toBe(true);
    expect(triggerMatchesText('/ui-audit', 'nothing here')).toBe(false);
  });

  it('escapes regex metacharacters inside triggers', () => {
    expect(triggerMatchesText('c++ tips', 'need some c++ tips today')).toBe(true);
    expect(triggerMatchesText('what?', 'what happened')).toBe(false);
  });
});
