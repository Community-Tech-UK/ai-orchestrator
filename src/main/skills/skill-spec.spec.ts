import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  validateSkillName,
  parseSkillFrontmatter,
  parseSkillMetadata,
  createSkillIgnoreMatcher,
} from './skill-spec';

describe('validateSkillName (Task 12)', () => {
  it('accepts lowercase, digits, hyphen, underscore, and a single plugin prefix', () => {
    for (const name of ['code-review', 'skill_1', 'a', 'plugin:skill', 'my-plugin:my_skill-2']) {
      expect(validateSkillName(name)).toEqual({ ok: true });
    }
  });

  it('rejects empty, uppercase, whitespace, path separators, and double colons', () => {
    for (const name of ['', 'Code-Review', 'code review', 'a/b', 'a\\b', 'plugin::skill', 'a:b:c', '../evil']) {
      expect(validateSkillName(name).ok).toBe(false);
    }
  });

  it('rejects overly long names', () => {
    expect(validateSkillName('a'.repeat(201)).ok).toBe(false);
  });
});

describe('parseSkillFrontmatter (Task 12)', () => {
  it('returns null when there is no frontmatter block', () => {
    expect(parseSkillFrontmatter('# just a heading\n')).toBeNull();
  });

  it('parses a colon-bearing quoted description that the old split(":") mangled', () => {
    const raw = parseSkillFrontmatter('---\nname: demo\ndescription: "Use when X: do Y, then Z"\n---\nbody');
    expect(raw).toMatchObject({ name: 'demo', description: 'Use when X: do Y, then Z' });
  });

  it('parses YAML list syntax for triggers', () => {
    const raw = parseSkillFrontmatter('---\nname: demo\ntriggers:\n  - alpha\n  - "beta, gamma"\n---\n');
    expect(raw?.['triggers']).toEqual(['alpha', 'beta, gamma']);
  });

  it('returns null on malformed YAML instead of throwing', () => {
    expect(parseSkillFrontmatter('---\nname: [unclosed\n---\n')).toBeNull();
  });
});

describe('parseSkillMetadata (Task 12)', () => {
  it('maps legacy singular trigger to triggers[]', () => {
    const metadata = parseSkillMetadata(
      '---\nname: code-review\ntrigger: /code-review\ndescription: Review code\n---\n',
      'fallback',
    );
    expect(metadata.name).toBe('code-review');
    expect(metadata.triggers).toEqual(['/code-review']);
  });

  it('preserves legacy model aliases accepted by the old skill parser', () => {
    for (const field of ['preferred_model', 'model']) {
      const metadata = parseSkillMetadata(
        `---\nname: model-demo\ndescription: Uses an explicit model\n${field}: claude-opus-4-1\n---\n`,
        'fallback',
      );

      expect(metadata.preferredModel).toBe('claude-opus-4-1');
    }
  });
});

describe('createSkillIgnoreMatcher (Task 12)', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('ignores nothing when no ignore file is present', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-ignore-'));
    const matcher = await createSkillIgnoreMatcher(dir);
    expect(matcher.ignores('references/anything.md')).toBe(false);
  });

  it('honors .skillignore patterns with gitignore semantics', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-ignore-'));
    await fs.writeFile(path.join(dir, '.skillignore'), '*.png\ncache/\n');
    const matcher = await createSkillIgnoreMatcher(dir);
    expect(matcher.ignores('assets/screenshot.png')).toBe(true);
    expect(matcher.ignores('cache/big.json')).toBe(true);
    expect(matcher.ignores('references/guide.md')).toBe(false);
  });
});
