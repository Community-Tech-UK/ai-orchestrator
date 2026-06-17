import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const builtinSkillDir = join(process.cwd(), 'src/main/skills/builtin');

describe('built-in fan-out skills', () => {
  it.each([
    'verify-implementation',
    'code-review',
    'debate-topic',
    'spawn-research-team',
    'summarize-children',
  ])('%s steers child fan-out away from Claude by default', (skillName) => {
    const skill = readFileSync(join(builtinSkillDir, skillName, 'SKILL.md'), 'utf8');

    expect(skill).toContain('non-Claude provider');
    expect(skill).toContain('unless the user explicitly requested Claude');
  });
});
