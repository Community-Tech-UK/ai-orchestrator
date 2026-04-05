import { describe, it, expect } from 'vitest';
import { ModeValidator } from '../validators/mode-validator';
import { CommandParser } from '../command-parser';
import type { ValidationContext } from '../types';

const validator = new ModeValidator();
const parser = new CommandParser();

function check(cmd: string, mode: ValidationContext['mode'], yolo = false) {
  const ctx: ValidationContext = {
    mode,
    workspacePath: '/workspace',
    instanceDepth: 0,
    yoloMode: yolo,
    instanceId: 'test',
  };
  return validator.validate(cmd, parser.parse(cmd), ctx);
}

describe('ModeValidator', () => {
  describe('read_only mode', () => {
    it('blocks write commands via ReadOnlyValidator', () => {
      expect(check('rm file', 'read_only').action).toBe('block');
    });

    it('allows read commands', () => {
      expect(check('ls -la', 'read_only').action).toBe('allow');
    });
  });

  describe('workspace_write mode', () => {
    it('warns on write to system paths', () => {
      const result = check('cp file /etc/config', 'workspace_write');
      expect(result.action).toBe('warn');
    });

    it('allows writes within workspace', () => {
      expect(check('touch /workspace/file.txt', 'workspace_write').action).toBe('allow');
    });

    it('allows commands without obvious system paths', () => {
      expect(check('npm install lodash', 'workspace_write').action).toBe('allow');
    });
  });

  describe('prompt mode', () => {
    it('always returns allow', () => {
      expect(check('rm -rf /', 'prompt').action).toBe('allow');
      expect(check('dd if=/dev/zero of=/dev/sda', 'prompt').action).toBe('allow');
    });
  });

  describe('allow mode', () => {
    it('always returns allow', () => {
      expect(check('rm -rf /', 'allow').action).toBe('allow');
    });
  });

  describe('YOLO mode', () => {
    it('bypasses all mode checks', () => {
      expect(check('rm file', 'read_only', true).action).toBe('allow');
      expect(check('cp file /etc/', 'workspace_write', true).action).toBe('allow');
    });
  });
});
