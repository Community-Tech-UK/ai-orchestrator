import { describe, expect, it } from 'vitest';
import type { SkillBundle } from '../../shared/types/skill.types';
import { buildSkillHealthCatalog } from './skill-health-catalog';

describe('buildSkillHealthCatalog', () => {
  it('includes unactivated registry skills with source defaults and explicit controls', () => {
    const bundle = (name: string, path: string): SkillBundle => ({
      id: name,
      path,
      corePath: `${path}/SKILL.md`,
      referencePaths: [],
      examplePaths: [],
      scriptPaths: [],
      assetPaths: [],
      metadata: { name, description: '', triggers: [], version: '1' },
    });
    const catalog = buildSkillHealthCatalog(
      [
        bundle('external', '/home/user/.agents/skills/external'),
        bundle('suggested', '/home/user/.agents/skills/suggested'),
        bundle('builtin', '/app/skills/builtin/builtin'),
      ],
      [{ skillName: 'external', mode: 'disabled', reason: null, updatedAt: 1 }],
      (path) => path.includes('/builtin/') ? 'builtin' : 'global',
      (source) => source === 'builtin' ? 'enabled' : 'suggest-only',
    );

    expect(catalog).toEqual([
      { skillName: 'external', source: 'global', effectiveMode: 'disabled' },
      { skillName: 'suggested', source: 'global', effectiveMode: 'suggest-only' },
      { skillName: 'builtin', source: 'builtin', effectiveMode: 'enabled' },
    ]);
  });
});
