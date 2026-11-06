import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHECKER_REQUIRED_SKILLS,
  _resetRequiredSkillsForTesting,
  installedSkillNames,
  requiredSkillNames,
  requiredSkillInputs,
  skillRoots,
  skillsNamedInText,
  withRequiredSkillMentions,
} from './codex-required-skills';

let home: string;
let repo: string;

function addSkill(root: string, name: string, withFile = true): void {
  mkdirSync(join(root, name), { recursive: true });
  if (withFile) writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
}

beforeEach(() => {
  _resetRequiredSkillsForTesting();
  home = mkdtempSync(join(tmpdir(), 'aio-skills-home-'));
  repo = mkdtempSync(join(tmpdir(), 'aio-skills-repo-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe('skill discovery', () => {
  it('lists repository and user skills that hold a SKILL.md, closest root first', () => {
    expect(skillRoots(repo, home)).toEqual([
      join(repo, '.agents', 'skills'), join(repo, '.codex', 'skills'), join(home, '.agents', 'skills'), join(home, '.codex', 'skills'),
    ]);
    addSkill(join(home, '.agents', 'skills'), 'task-completion-gate');
    addSkill(join(repo, '.agents', 'skills'), 'repo-skill');
    addSkill(join(home, '.codex', 'skills'), 'empty-folder', false);
    addSkill(join(home, '.codex', 'skills'), 'bad name!');
    expect([...installedSkillNames(skillRoots(repo, home))].sort()).toEqual(['repo-skill', 'task-completion-gate']);
  });

  it('survives missing roots and caches for a minute', () => {
    const roots = skillRoots(undefined, home);
    expect([...installedSkillNames(roots, 1_000)]).toEqual([]);
    addSkill(join(home, '.agents', 'skills'), 'late-skill');
    expect([...installedSkillNames(roots, 30_000)]).toEqual([]);
    expect([...installedSkillNames(roots, 70_000)]).toEqual(['late-skill']);
  });
});

describe('skills a prompt names', () => {
  const installed = new Set(['task-completion-gate', 'playwright']);

  it('finds a skill named in backticks near the word skill, or as "name skill"', () => {
    expect(skillsNamedInText('Use the `task-completion-gate` skill before you answer.', installed)).toEqual(['task-completion-gate']);
    expect(skillsNamedInText('Skill: `playwright` is allowed here.', installed)).toEqual(['playwright']);
    expect(skillsNamedInText('Run the playwright skill on the page.', installed)).toEqual(['playwright']);
  });

  it('ignores an explicit $name mention, a bare path or word, and skills that are not installed', () => {
    expect(skillsNamedInText('Use $task-completion-gate for this.', installed)).toEqual([]);
    expect(skillsNamedInText('Edit docs/task-completion-gate-notes.md and read playwright logs.', installed)).toEqual([]);
    expect(skillsNamedInText('Use the `missing-skill` skill.', installed)).toEqual([]);
  });
});

describe('required skills for a turn', () => {
  const installed = new Set<string>(CHECKER_REQUIRED_SKILLS);

  it('gives chats and unknown kinds nothing, because they keep Codex\'s own catalog budget', () => {
    expect(requiredSkillNames({ sessionKind: 'chat', queueRole: 'verifier', skillCatalogOmitted: true }, 'x', installed)).toEqual([]);
    expect(requiredSkillNames({}, 'Use the `task-completion-gate` skill', installed)).toEqual([]);
  });

  it('names the skills a capped session\'s prompt refers to', () => {
    expect(requiredSkillNames({ sessionKind: 'plan-queue', queueRole: 'worker' }, 'Use the `task-completion-gate` skill at the end.', installed)).toEqual(['task-completion-gate']);
    expect(requiredSkillNames({ sessionKind: 'loop' }, 'Just implement the plan.', installed)).toEqual([]);
  });

  it('adds the governing skills only for a checker whose catalog was really omitted', () => {
    const base = { sessionKind: 'plan-queue' as const, queueRole: 'verifier' };
    expect(requiredSkillNames({ ...base, skillCatalogOmitted: true }, 'Judge the work.', installed)).toEqual(['task-completion-gate']);
    expect(requiredSkillNames({ ...base, skillCatalogOmitted: false }, 'Judge the work.', installed)).toEqual([]);
    expect(requiredSkillNames({ ...base, skillCatalogOmitted: true }, 'Judge the work.', new Set())).toEqual([]);
    expect(requiredSkillNames({ sessionKind: 'plan-queue', queueRole: 'worker', skillCatalogOmitted: true }, 'Do it.', installed)).toEqual([]);
  });

  it('adds one trailing line, once per skill, and leaves other text alone', () => {
    const config = { sessionKind: 'plan-queue' as const, queueRole: 'verifier', skillCatalogOmitted: true };
    const text = 'Use the `task-completion-gate` skill. Judge the work.';
    expect(withRequiredSkillMentions(config, text, installed)).toBe(`${text}\n\nSkills for this turn: $task-completion-gate`);
    expect(withRequiredSkillMentions({ sessionKind: 'chat' }, text, installed)).toBe(text);
    expect(withRequiredSkillMentions({ sessionKind: 'plan-queue' }, 'Nothing named.', installed)).toBe('Nothing named.');
  });

  it('discovers installed skills from the working folder when none are passed in', () => {
    addSkill(join(repo, '.agents', 'skills'), 'task-completion-gate');
    expect(requiredSkillNames({ sessionKind: 'plan-queue', queueRole: 'verifier', skillCatalogOmitted: true, workingDir: repo }, 'Judge.')).toContain('task-completion-gate');
  });
});


describe('explicit protocol selection for internal input', () => {
  it('uses the canonical exact file path for a skill reached through a linked folder', () => {
    const actual = join(home, 'shared-local-skill');
    mkdirSync(actual, { recursive: true });
    writeFileSync(join(actual, 'SKILL.md'), '---\nname: phase-d-linked-skill\n---\n');
    const root = join(repo, '.agents', 'skills');
    mkdirSync(root, { recursive: true });
    symlinkSync(actual, join(root, 'phase-d-linked-skill'), 'dir');
    expect(requiredSkillInputs({ sessionKind: 'loop', workingDir: repo }, 'Use $phase-d-linked-skill.')).toEqual([
      { type: 'skill', name: 'phase-d-linked-skill', path: realpathSync(join(actual, 'SKILL.md')) },
    ]);
  });

  it('selects a locally overriding path once when the text and checker policy both require it', () => {
    addSkill(join(repo, '.agents', 'skills'), 'task-completion-gate');
    addSkill(join(repo, '.codex', 'skills'), 'task-completion-gate');
    const config = { sessionKind: 'plan-queue' as const, queueRole: 'verifier', skillCatalogOmitted: true, workingDir: repo };
    expect(requiredSkillInputs(config, 'Use $task-completion-gate and the `task-completion-gate` skill.')).toEqual([
      { type: 'skill', name: 'task-completion-gate', path: realpathSync(join(repo, '.agents', 'skills', 'task-completion-gate', 'SKILL.md')) },
    ]);
  });
});
