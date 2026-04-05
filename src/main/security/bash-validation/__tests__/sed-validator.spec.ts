import { describe, it, expect } from 'vitest';
import { SedValidator } from '../validators/sed-validator';
import { CommandParser } from '../command-parser';
import type { ValidationContext } from '../types';

const validator = new SedValidator();
const parser = new CommandParser();

function check(cmd: string, mode: ValidationContext['mode'] = 'prompt') {
  const ctx: ValidationContext = {
    mode, workspacePath: '/workspace', instanceDepth: 0, yoloMode: false, instanceId: 'test',
  };
  return validator.validate(cmd, parser.parse(cmd), ctx);
}

describe('SedValidator', () => {
  it('blocks sed -i in read_only mode', () => {
    expect(check('sed -i "s/foo/bar/" file.txt', 'read_only').action).toBe('block');
  });

  it('warns on sed -i targeting system paths in workspace_write mode', () => {
    expect(check('sed -i "s/foo/bar/" /etc/config', 'workspace_write').action).toBe('warn');
  });

  it('blocks sed write flag', () => {
    expect(check("sed 's/.*/w /tmp/stolen'").action).toBe('block');
  });

  it('blocks sed execute flag', () => {
    expect(check("sed -n '1e rm -rf /'").action).toBe('block');
  });

  it('allows normal sed usage', () => {
    expect(check('sed "s/foo/bar/" file.txt').action).toBe('allow');
    expect(check('sed -n "1,10p" file.txt').action).toBe('allow');
  });

  it('ignores non-sed commands', () => {
    expect(check('grep pattern file').action).toBe('allow');
  });
});
