import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_PLAN_DOCUMENT_PATTERN,
  MARKER_HEADER_LINES,
  STANDING_REGISTER_MARKER,
  declaresNotAnItem,
  declaresStandingRegister,
  isActivePlanDocumentPath,
} from './active-plan-pattern';
import { hermeticGitEnv } from './git-env';

vi.setConfig({ testTimeout: 30_000 });

/**
 * `fixtures/plan-spec-guard.hook.sh` is a verbatim copy of the shared hook
 * (~/.config/git/hooks/plan-spec-guard.sh). The pattern in
 * `active-plan-pattern.ts` and that hook MUST change together: when the hook
 * changes, copy it over the fixture and update the module until this file
 * passes again.
 */
const FIXTURE = join(__dirname, 'fixtures', 'plan-spec-guard.hook.sh');
const fixtureText = readFileSync(FIXTURE, 'utf8');

const NAMES = [
  'docs/plans/a_plan.md',
  'docs/plans/a_spec.md',
  'docs/plans/a_spec_planned.md',
  'docs/plans/a_livetest.md',
  'docs/plans/a_history.md',
  'docs/plans/a-decisions-for-james.md',
  'docs/plans/a_plan_completed.md',
  'docs/plans/a_history_0123_completed.md',
  'docs/plans/a_plan.from-queue-ab12cd.md',
  'docs/plans/a_PLAN.md',
  'docs/plans/a_plan.md.bak',
  'docs/notes.md',
  'src/plan.ts',
  '_plan.md',
];

describe('active plan pattern', () => {
  it('has the same pattern, marker and header length as the hook fixture', () => {
    const pattern = /grep -E '(.+)' \|\| true/.exec(fixtureText)?.[1];
    expect(pattern).toBeDefined();
    expect(ACTIVE_PLAN_DOCUMENT_PATTERN.source).toBe(pattern);
    expect(ACTIVE_PLAN_DOCUMENT_PATTERN.flags).toBe('');
    expect(/^MARKER='(.+)'$/m.exec(fixtureText)?.[1]).toBe(STANDING_REGISTER_MARKER);
    expect(/head -(\d+) \| grep -qF/.exec(fixtureText)?.[1]).toBe(String(MARKER_HEADER_LINES));
  });

  describe('against the hook itself', () => {
    let repo: string;
    const git = (args: string[]): string => execFileSync('git', args, { cwd: repo, env: hermeticGitEnv(), encoding: 'utf8' });

    beforeEach(() => {
      repo = mkdtempSync(join(tmpdir(), 'active-plan-pattern-'));
      git(['init', '-q', '-b', 'main']);
    });
    afterEach(() => rmSync(repo, { recursive: true, force: true }));

    /** The files the fixture hook refuses when `files` are staged. */
    function hookBlocks(files: Record<string, string>): string[] {
      for (const [file, content] of Object.entries(files)) {
        mkdirSync(dirname(join(repo, file)), { recursive: true });
        writeFileSync(join(repo, file), content);
      }
      git(['add', '-A']);
      const result = (() => {
        try {
          execFileSync('sh', [FIXTURE], { cwd: repo, env: hermeticGitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          return '';
        } catch (error) {
          return String((error as { stderr?: unknown }).stderr ?? '');
        }
      })();
      return Object.keys(files).filter((file) => result.split('\n').includes(`  ${file}`));
    }

    it('blocks exactly the names the module calls active', () => {
      const files = Object.fromEntries(NAMES.map((name) => [name, '# doc\n']));
      expect(hookBlocks(files).sort()).toEqual(NAMES.filter(isActivePlanDocumentPath).sort());
    });

    it('exempts exactly what the module calls a standing register', () => {
      const cases: Record<string, string> = {
        'a_plan.md': '# A\n\nType: standing register\n',
        'b_plan.md': '# B\n\n**Type: standing register — kept**\n',
        'c_plan.md': '# C\n\n**Type:** standing register\n',
        'd_plan.md': `# D\n${'\n'.repeat(7)}Type: standing register\n`,
        'e_plan.md': `# E\n${'\n'.repeat(6)}Type: standing register\n`,
        'f_plan.md': '# F\n\ntype: standing register\n',
      };
      const blocked = hookBlocks(cases);
      for (const [file, content] of Object.entries(cases)) {
        expect(blocked.includes(file), file).toBe(!declaresStandingRegister(content));
      }
      expect(declaresStandingRegister(cases['d_plan.md'])).toBe(false);
      expect(declaresStandingRegister(cases['e_plan.md'])).toBe(true);
    });
  });

  it('drops the bold Type form that discovery used to accept', () => {
    expect(declaresStandingRegister('# R\n**Type:** standing register\n')).toBe(false);
    expect(declaresStandingRegister('# R\n**Type: standing register**\n')).toBe(true);
  });

  it('reads the not-an-item marker from the first 8 lines only', () => {
    expect(declaresNotAnItem('# P\n\nQueue: not an item\n')).toBe(true);
    expect(declaresNotAnItem(`# P\n${'\n'.repeat(7)}Queue: not an item\n`)).toBe(false);
    expect(declaresNotAnItem('# P\n\nQueue: not an item, really\n')).toBe(false);
  });
});
