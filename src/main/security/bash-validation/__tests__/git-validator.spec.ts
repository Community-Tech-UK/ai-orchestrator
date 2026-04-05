import { describe, it, expect } from 'vitest';
import { GitValidator } from '../validators/git-validator';
import { CommandParser } from '../command-parser';
import type { ValidationContext } from '../types';

const validator = new GitValidator();
const parser = new CommandParser();
const ctx: ValidationContext = {
  mode: 'prompt', workspacePath: '/workspace', instanceDepth: 0, yoloMode: false, instanceId: 'test',
};

function check(cmd: string) {
  return validator.validate(cmd, parser.parse(cmd), ctx);
}

describe('GitValidator', () => {
  describe('blocked patterns', () => {
    it.each([
      'git push --force origin main',
      'git push -f origin master',
      'git filter-branch --tree-filter "rm secrets" HEAD',
      'git reflog expire --expire=now --all',
      'git config core.pager "less; rm -rf /"',
      'git clone --config core.fsmonitor="!rm -rf /" repo',
    ])('blocks "%s"', (cmd) => {
      expect(check(cmd).action).toBe('block');
    });
  });

  describe('warn patterns', () => {
    it.each([
      'git push --force origin feature-branch',
      'git push --force-with-lease',
      'git reset --hard',
      'git clean -fd', 'git clean -fdx',
      'git checkout -- .', 'git restore .',
      'git rebase main',
      'git gc --prune=now',
    ])('warns on "%s"', (cmd) => {
      expect(check(cmd).action).toBe('warn');
    });
  });

  describe('safe git commands', () => {
    it.each([
      'git status', 'git log --oneline', 'git diff HEAD',
      'git commit -m "fix"', 'git add file.ts',
      'git push origin feature', 'git pull origin main',
      'git branch -a', 'git stash',
    ])('allows "%s"', (cmd) => {
      expect(check(cmd).action).toBe('allow');
    });
  });

  describe('non-git commands', () => {
    it('ignores non-git commands', () => {
      expect(check('ls -la').action).toBe('allow');
      expect(check('npm test').action).toBe('allow');
    });
  });
});
