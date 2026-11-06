import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  PLAYWRIGHT_CHROMIUM_PATTERN,
  SIGNAL_FENCE_EXEC,
  SIGNAL_FENCE_POLICY,
  applySignalFence,
  isRefusedAsNested,
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

describe('isRefusedAsNested', () => {
  it('recognises only the refusal to start inside another sandbox', () => {
    const refusal = 'sandbox-exec: sandbox_apply: Operation not permitted\n';
    expect(isRefusedAsNested({ status: 71, stderr: refusal })).toBe(true);
    expect(isRefusedAsNested({ status: 0, stderr: '' })).toBe(false);
    expect(isRefusedAsNested({ status: 65, stderr: 'sandbox-exec: unbound variable: x\n' })).toBe(false);
    expect(isRefusedAsNested({ status: null, stderr: '' })).toBe(false);
    // What spawnSync returns when sandbox-exec could not start at all.
    expect(isRefusedAsNested(spawnSync('/nonexistent/sandbox-exec', [], { encoding: 'utf8' }))).toBe(false);
  });
});

describe('Playwright Chromium exception', () => {
  const cache = `${homedir()}/Library/Caches/ms-playwright`;
  const pattern = new RegExp(PLAYWRIGHT_CHROMIUM_PATTERN);

  it('lets only the Chromium builds start outside the fence', () => {
    expect(SIGNAL_FENCE_POLICY).toContain(`(allow process-exec (regex #"${PLAYWRIGHT_CHROMIUM_PATTERN}") (with no-sandbox))`);
    expect(pattern.test(`${cache}/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell`)).toBe(true);
    expect(pattern.test(`${cache}/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)).toBe(true);
  });

  it('keeps every other program inside the fence', () => {
    for (const path of [
      '/bin/sh',
      '/usr/bin/pkill',
      `${cache}/webkit-2368/pw_run.sh`,
      `${cache}/ffmpeg-1011/ffmpeg-mac`,
      `${cache}/chromium-extra/tool`,
      `/tmp${cache}/chromium-1228/tool`,
    ]) {
      expect(pattern.test(path), path).toBe(false);
    }
  });

  // A policy macOS cannot read would stop every session starting. Inside a
  // Harness session applying it is refused, but only after it has been read.
  it.runIf(process.platform === 'darwin')('is a policy macOS can read', () => {
    const fenced = applySignalFence({ command: '/usr/bin/true', args: [], enabled: true });
    const result = spawnSync(fenced.command, fenced.args, { encoding: 'utf8' });
    expect(result.status === 0 || result.stderr.includes('sandbox_apply: Operation not permitted'), result.stderr).toBe(true);
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
        // The fence holds when the victim is still alive. Seatbelt sometimes
        // drops the signal and still lets /bin/kill exit 0, so a zero status
        // is only a failure when the victim actually died.
        expect(() => process.kill(victim.pid!, 0)).not.toThrow();
        if (result.status !== 0) {
          expect(`${result.stderr}`).toMatch(/Operation not permitted/);
        }
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
