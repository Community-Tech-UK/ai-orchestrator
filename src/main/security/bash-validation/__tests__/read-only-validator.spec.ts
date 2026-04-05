import { describe, it, expect } from 'vitest';
import { ReadOnlyValidator } from '../validators/read-only-validator';
import { CommandParser } from '../command-parser';
import type { ValidationContext } from '../types';

const validator = new ReadOnlyValidator();
const parser = new CommandParser();
const ctx: ValidationContext = {
  mode: 'read_only',
  workspacePath: '/workspace',
  instanceDepth: 0,
  yoloMode: false,
  instanceId: 'test',
};

function check(cmd: string) {
  return validator.validate(cmd, parser.parse(cmd), ctx);
}

describe('ReadOnlyValidator', () => {
  describe('blocks write commands', () => {
    it.each([
      'cp src dest',
      'mv old new',
      'rm file',
      'mkdir dir',
      'rmdir dir',
      'touch file',
      'chmod 755 file',
      'chown user file',
      'ln -s a b',
      'truncate -s 0 file',
      'dd if=/dev/zero of=file',
    ])('blocks "%s" in read_only mode', (cmd) => {
      expect(check(cmd).action).toBe('block');
    });
  });

  describe('blocks state-modifying commands', () => {
    it.each([
      'apt update',
      'pip install requests',
      'npm install lodash',
      'docker run hello-world',
      'systemctl restart nginx',
      'kill -9 1234',
      'reboot',
      'crontab -e',
    ])('blocks "%s" in read_only mode', (cmd) => {
      expect(check(cmd).action).toBe('block');
    });
  });

  describe('blocks write redirections', () => {
    it.each([
      'echo hello > file.txt',
      'echo hello >> file.txt',
    ])('blocks "%s" in read_only mode', (cmd) => {
      expect(check(cmd).action).toBe('block');
    });
  });

  describe('allows read commands', () => {
    it.each([
      'ls -la',
      'cat file',
      'grep pattern file',
      'head -n 10 file',
      'pwd',
      'whoami',
      'uname -a',
      'date',
      'echo hello',
      'find . -name "*.ts"',
      'wc -l file',
    ])('allows "%s" in read_only mode', (cmd) => {
      expect(check(cmd).action).toBe('allow');
    });
  });

  describe('git subcommand handling', () => {
    it.each([
      'git status',
      'git log',
      'git diff',
      'git show HEAD',
      'git branch',
      'git remote -v',
      'git ls-files',
      'git rev-parse HEAD',
      'git blame file.ts',
    ])('allows safe git: "%s"', (cmd) => {
      expect(check(cmd).action).toBe('allow');
    });

    it.each([
      'git commit -m "msg"',
      'git push',
      'git merge dev',
      'git rebase main',
      'git checkout dev',
      'git add .',
      'git reset --hard',
      'git clean -fd',
      'git pull',
    ])('blocks write git: "%s"', (cmd) => {
      expect(check(cmd).action).toBe('block');
    });
  });

  describe('skips in non-read_only mode', () => {
    it('returns allow in prompt mode', () => {
      const promptCtx: ValidationContext = { ...ctx, mode: 'prompt' };
      expect(validator.validate('rm file', parser.parse('rm file'), promptCtx).action).toBe('allow');
    });
  });
});
