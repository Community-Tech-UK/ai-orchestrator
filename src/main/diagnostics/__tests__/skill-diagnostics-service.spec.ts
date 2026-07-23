import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillBundle } from '../../../shared/types/skill.types';
import { SkillDiagnosticsService } from '../skill-diagnostics-service';

let tempDir: string | null = null;

describe('SkillDiagnosticsService', () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('reports invalid frontmatter, missing files, duplicate names, and duplicate triggers', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-diag-'));
    const skillOneCore = join(tempDir, 'one-SKILL.md');
    const skillTwoCore = join(tempDir, 'two-SKILL.md');
    const missingReference = join(tempDir, 'missing.md');
    await writeFile(skillOneCore, 'no frontmatter');
    await writeFile(skillTwoCore, [
      '---',
      'name: Example',
      'description: Example skill',
      'triggers:',
      '  - review',
      '---',
      'content',
    ].join('\n'));

    const skills: SkillBundle[] = [
      makeSkill('skill-one', 'Example', skillOneCore, [missingReference]),
      makeSkill('skill-two', 'Example', skillTwoCore, []),
    ];
    const service = new SkillDiagnosticsService({
      listSkills: () => skills,
      getTriggerIndex: () => new Map([['review', ['skill-one', 'skill-two']]]),
    });

    const diagnostics = await service.collect();

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-frontmatter', skillId: 'skill-one' }),
        expect.objectContaining({ code: 'missing-file', filePath: missingReference }),
        expect.objectContaining({ code: 'duplicate-skill-name' }),
        expect.objectContaining({ code: 'duplicate-trigger', trigger: 'review' }),
      ]),
    );
  });
  it('lints over-broad triggers, weak descriptions, and oversized cores', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-diag-'));
    const corePath = join(tempDir, 'linty-SKILL.md');
    await writeFile(corePath, [
      '---',
      'name: linty',
      'description: short',
      'triggers:',
      '  - test',
      '  - /linty',
      '---',
      'content',
    ].join('\n'));

    const skill = makeSkill('skill-linty', 'linty', corePath, []);
    skill.metadata.description = 'short';
    skill.metadata.triggers = ['test', '/linty'];
    skill.metadata.coreSize = 20_000;

    const service = new SkillDiagnosticsService({
      listSkills: () => [skill],
      getTriggerIndex: () => new Map<string, string[]>(),
    });

    const diagnostics = await service.collect();

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'over-broad-trigger', trigger: 'test' }),
        expect.objectContaining({ code: 'weak-description', skillName: 'linty' }),
        expect.objectContaining({ code: 'oversized-core', skillName: 'linty' }),
      ]),
    );
    // Slash triggers are typed deliberately and must never be flagged.
    expect(diagnostics.some(
      (diag) => diag.code === 'over-broad-trigger' && diag.trigger === '/linty',
    )).toBe(false);
  });
});

function makeSkill(
  id: string,
  name: string,
  corePath: string,
  referencePaths: string[],
): SkillBundle {
  return {
    id,
    path: corePath,
    metadata: {
      name,
      description: `${name} description`,
      triggers: ['review'],
      version: '1.0.0',
    },
    corePath,
    referencePaths,
    examplePaths: [],
    scriptPaths: [],
    assetPaths: [],
  };
}
