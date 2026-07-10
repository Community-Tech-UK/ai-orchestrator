import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillRegistry, _resetSkillRegistryForTesting } from '../skill-registry';

const builtinSkillDir = join(process.cwd(), 'src/main/skills/builtin');
const FAN_OUT_SKILLS = [
  'verify-implementation',
  'code-review',
  'debate-topic',
  'spawn-research-team',
  'summarize-children',
];

describe('built-in fan-out skills', () => {
  afterEach(() => {
    _resetSkillRegistryForTesting();
  });

  it('discovers legacy single-trigger built-ins through registry discovery', async () => {
    _resetSkillRegistryForTesting();
    const registry = SkillRegistry.getInstance();
    const skills = await registry.discoverSkillsWithBuiltins([]);
    const discoveredNames = new Set(skills.map((skill) => skill.metadata.name));

    for (const skillName of FAN_OUT_SKILLS) {
      expect(discoveredNames.has(skillName), `${skillName} discovered`).toBe(true);
    }

    expect(registry.matchTrigger('/verify')[0]?.skill.metadata.name).toBe('verify-implementation');
  });

  it('discovers human public writing skill for tone and public-facing writing triggers', async () => {
    _resetSkillRegistryForTesting();
    const registry = SkillRegistry.getInstance();
    const skills = await registry.discoverSkillsWithBuiltins([]);
    const discoveredNames = new Set(skills.map((skill) => skill.metadata.name));

    expect(discoveredNames.has('human-public-writing')).toBe(true);
    expect(registry.matchTrigger('use my tone on this email')[0]?.skill.metadata.name)
      .toBe('human-public-writing');
  });

  it('requires structural voice matching instead of surface cleanup alone', () => {
    const skill = readFileSync(
      join(builtinSkillDir, 'human-public-writing', 'SKILL.md'),
      'utf8',
    );

    expect(skill).toContain('## Structural Voice Matching');
    expect(skill).toContain('Match the shape before the polish');
    expect(skill).toContain('## Channel Calibration');
    expect(skill).toContain('Do not imitate typos');
  });

  it.each(FAN_OUT_SKILLS)('%s steers child fan-out away from Claude by default', (skillName) => {
    const skill = readFileSync(join(builtinSkillDir, skillName, 'SKILL.md'), 'utf8');

    expect(skill).toContain('non-Claude provider');
    expect(skill).toContain('unless the user explicitly requested Claude');
  });
});
