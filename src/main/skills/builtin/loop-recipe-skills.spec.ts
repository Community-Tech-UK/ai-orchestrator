import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillRegistry, _resetSkillRegistryForTesting } from '../skill-registry';

const builtinSkillDir = join(process.cwd(), 'src/main/skills/builtin');

const LOOP_RECIPE_SKILLS = [
  'test-stabilizer',
  'contract-alias-audit',
  'fresh-clone',
  'docs-sweep',
  'error-sweep',
];

describe('built-in loop-recipe skills', () => {
  afterEach(() => {
    _resetSkillRegistryForTesting();
  });

  it('discovers loop recipes through built-in registry discovery', async () => {
    _resetSkillRegistryForTesting();
    const registry = SkillRegistry.getInstance();
    const skills = await registry.discoverSkillsWithBuiltins([]);
    const discoveredNames = new Set(skills.map((skill) => skill.metadata.name));

    for (const skillName of LOOP_RECIPE_SKILLS) {
      expect(discoveredNames.has(skillName), `${skillName} discovered`).toBe(true);
    }

    expect(registry.matchTrigger('/docs-sweep')[0]?.skill.metadata.name).toBe('docs-sweep');
  });

  it.each(LOOP_RECIPE_SKILLS)('%s declares valid frontmatter', (skillName) => {
    const content = readFileSync(join(builtinSkillDir, skillName, 'SKILL.md'), 'utf8');
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);

    expect(frontmatter, `${skillName} frontmatter`).not.toBeNull();
    const block = frontmatter![1];

    expect(block, `${skillName} name`).toMatch(/^name:\s*\S/m);
    expect(block, `${skillName} description`).toMatch(/^description:\s*\S/m);
    expect(block, `${skillName} triggers array`).toMatch(/^triggers:\s*\[/m);
    expect(block, `${skillName} loop category`).toMatch(/^category:\s*loop$/m);
  });

  it.each(LOOP_RECIPE_SKILLS)('%s carries the authoring-template loop contract', (skillName) => {
    const content = readFileSync(join(builtinSkillDir, skillName, 'SKILL.md'), 'utf8');

    expect(content, `${skillName} objective`).toContain('**OBJECTIVE**');
    expect(content, `${skillName} checks`).toContain('**CHECKS**');
    expect(content, `${skillName} stop`).toContain('**STOP**');
    expect(content, `${skillName} guardrails`).toContain('**GUARDRAILS**');

    // The three explicit exits the Loop Library convention requires.
    expect(content, `${skillName} done exit`).toMatch(/done\s+—/);
    expect(content, `${skillName} stalled exit`).toMatch(/stalled\s+—/);
    expect(content, `${skillName} needs-permission exit`).toMatch(/needs-permission\s+—/);
  });
});
