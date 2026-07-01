import { describe, expect, it } from 'vitest';

import { parseSkillFrontmatter } from './skill.types';

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
