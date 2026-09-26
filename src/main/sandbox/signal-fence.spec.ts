import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  SIGNAL_FENCE_EXEC,
  SIGNAL_FENCE_POLICY,
  applySignalFence,
  isSignalFenceAvailable,
  unwrapSignalFence,
} from './signal-fence';

describe('applySignalFence', () => {
  it('returns the command unchanged when disabled', () => {
    expect(applySignalFence({
      command: 'opencode',
      args: ['acp', '--cwd', '/tmp'],
      enabled: false,
    })).toEqual({
      command: 'opencode',
      args: ['acp', '--cwd', '/tmp'],
    });
  });

  it('wraps with a signal-only Seatbelt policy when enabled', () => {
    const result = applySignalFence({
      command: 'opencode',
      args: ['acp', '--cwd', '/tmp'],
      enabled: true,
    });
    expect(result.command).toBe(SIGNAL_FENCE_EXEC);
    expect(result.args.slice(-5)).toEqual(['--', 'opencode', 'acp', '--cwd', '/tmp']);
    const policy = result.args[result.args.indexOf('-p') + 1];
    expect(policy).toBe(SIGNAL_FENCE_POLICY);
    expect(policy).toContain('(allow default)');
    expect(policy).toContain('(deny signal)');
    expect(policy).toContain('(allow signal (target same-sandbox))');
    expect(policy).not.toContain('(deny default)');
  });

  it('unwraps a fenced spawn back to the CLI command', () => {
    const fenced = applySignalFence({
      command: 'opencode',
      args: ['acp'],
      enabled: true,
    });
    expect(unwrapSignalFence(fenced.command, fenced.args)).toEqual({
      command: 'opencode',
      args: ['acp'],
    });
    expect(unwrapSignalFence('opencode', ['acp'])).toEqual({
      command: 'opencode',
      args: ['acp'],
    });
  });
});

describe('signal fence process isolation', () => {
  it.runIf(isSignalFenceAvailable())(
    'a fenced process cannot signal a process outside its sandbox',
    () => {
      const victim = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
      try {
        expect(victim.pid).toBeTruthy();
        const fenced = applySignalFence({
          command: '/bin/kill',
          args: ['-TERM', String(victim.pid)],
          enabled: true,
        });
        const result = spawnSync(fenced.command, fenced.args, { encoding: 'utf8' });
        expect(result.status).not.toBe(0);
        expect(`${result.stderr}`).toMatch(/Operation not permitted/);
        expect(() => process.kill(victim.pid!, 0)).not.toThrow();
      } finally {
        victim.kill('SIGTERM');
      }
    },
  );

  it.runIf(isSignalFenceAvailable())(
    'a fenced process can still signal a process it spawned',
    () => {
      const fenced = applySignalFence({
        command: '/bin/bash',
        args: ['-c', 'sleep 30 & CPID=$!; pkill -TERM -P $$; sleep 0.2; if kill -0 $CPID 2>/dev/null; then echo ALIVE; else echo DEAD; fi'],
        enabled: true,
      });
      const result = spawnSync(fenced.command, fenced.args, { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('DEAD');
    },
  );

  it.runIf(isSignalFenceAvailable())(
    'an unsandboxed parent can still signal the fenced process',
    async () => {
      const fenced = applySignalFence({
        command: '/bin/sleep',
        args: ['30'],
        enabled: true,
      });
      const child = spawn(fenced.command, fenced.args, { stdio: 'ignore' });
      const exited = new Promise<NodeJS.Signals | null>((resolve) => {
        child.once('exit', (_code, signal) => resolve(signal));
      });
      child.kill('SIGTERM');
      await expect(exited).resolves.toBe('SIGTERM');
    },
  );
});
