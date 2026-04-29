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
