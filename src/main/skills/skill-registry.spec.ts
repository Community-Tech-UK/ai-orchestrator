import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillRegistry, getSkillRegistry } from './skill-registry';

let tempDir: string | null = null;

async function writeSkill(root: string, dirName: string, frontmatter: string): Promise<string> {
  const skillDir = join(root, dirName);
  await mkdir(skillDir, { recursive: true });
  const corePath = join(skillDir, 'SKILL.md');
  await writeFile(corePath, `${frontmatter}\n# Body\n\nContent.\n`);
  return skillDir;
}

describe('SkillRegistry discovery', () => {
  beforeEach(() => {
    SkillRegistry._resetForTesting();
  });

  afterEach(async () => {
    SkillRegistry._resetForTesting();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('registers trigger-less Anthropic-format skills as embedding-only (D1a)', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-reg-'));
    await writeSkill(tempDir, 'anthropic-style', [
      '---',
      'name: anthropic-style',
      'description: A standard Anthropic SKILL.md with name and description only.',
      '---',
    ].join('\n'));
    await writeSkill(tempDir, 'legacy-style', [
      '---',
      'name: legacy-style',
      'description: A legacy skill with a trigger.',
      'triggers: ["/legacy-style"]',
      '---',
    ].join('\n'));

    const registry = getSkillRegistry();
    const discovered = await registry.discoverSkills([tempDir]);
    const names = discovered.map((bundle) => bundle.metadata.name).sort();

    expect(names).toEqual(['anthropic-style', 'legacy-style']);
    const anthropicStyle = discovered.find((b) => b.metadata.name === 'anthropic-style');
    expect(anthropicStyle?.metadata.triggers).toEqual([]);
  });

  it('still rejects skills with invalid names', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-reg-'));
    await writeSkill(tempDir, 'Bad Name Skill', [
      '---',
      'name: Bad Name With Spaces',
      'description: Invalid name should still be rejected.',
      '---',
    ].join('\n'));

    const registry = getSkillRegistry();
    const discovered = await registry.discoverSkills([tempDir]);

    expect(discovered).toEqual([]);
  });

  it('matches phrase triggers on word boundaries only', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-reg-'));
    await writeSkill(tempDir, 'release-helper', [
      '---',
      'name: release-helper',
      'description: Helps with releases.',
      'triggers: ["play api"]',
      '---',
    ].join('\n'));

    const registry = getSkillRegistry();
    await registry.discoverSkills([tempDir]);

    expect(registry.matchTrigger('use the play api for uploads')).toHaveLength(1);
    expect(registry.matchTrigger('the display apique layout')).toHaveLength(0);
  });
});
