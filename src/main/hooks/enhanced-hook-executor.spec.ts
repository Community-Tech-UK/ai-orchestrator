import { describe, it, expect } from 'vitest';
import { basename } from 'node:path';
import {
  EnhancedHookExecutor,
  type EnhancedHookConfig
} from './enhanced-hook-executor';

describe('EnhancedHookExecutor security', () => {
  const executor = EnhancedHookExecutor.getInstance();

  it('blocks shell metacharacters when allowShell is false', async () => {
    const hook: EnhancedHookConfig = {
      id: 'hook-shell-block',
      name: 'Block shell metachars',
      enabled: true,
      event: 'PreToolUse',
      timing: 'pre',
      blocking: true,
      handler: {
        type: 'command',
        command: 'echo test | cat'
      }
    };

    const result = await executor.execute(hook, {});
    expect(result.action).toBe('block');
    expect(result.error).toContain('Shell features are disabled');
  });

  it('blocks script execution when allowScript is false', async () => {
    const hook: EnhancedHookConfig = {
      id: 'hook-script-block',
      name: 'Block script execution',
      enabled: true,
      event: 'PreToolUse',
      timing: 'pre',
      blocking: true,
      handler: {
        type: 'script',
        scriptPath: './scripts/test.sh'
      }
    };

    const result = await executor.execute(hook, {});
    expect(result.action).toBe('block');
    expect(result.error).toContain('Script execution is disabled');
  });

  it('enforces executable allowlist when provided', async () => {
    const hook: EnhancedHookConfig = {
      id: 'hook-allowlist-block',
      name: 'Block non-allowlisted executables',
      enabled: true,
      event: 'PreToolUse',
      timing: 'pre',
      blocking: true,
      handler: {
        type: 'command',
        command: `${basename(process.execPath)} --version`,
        allowedExecutables: ['printf']
      }
    };

    const result = await executor.execute(hook, {});
    expect(result.action).toBe('block');
    expect(result.error).toContain('Executable not allowed');
  });
});
