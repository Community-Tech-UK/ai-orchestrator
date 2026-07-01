import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  parseTrustedConfigValue,
  resolveTrustedConfigValue,
  type TrustedCommandInvocation,
} from '../trusted-config-value-resolver';

describe('trusted config value resolver', () => {
  it('parses literal, env, file, and cmd tokens in order', () => {
    expect(parseTrustedConfigValue('a-${env:A}-${file:key.txt}-${cmd:security find-generic-password -w -s aio}')).toEqual([
      { type: 'literal', value: 'a-' },
      { type: 'env', name: 'A' },
      { type: 'literal', value: '-' },
      { type: 'file', path: 'key.txt' },
      { type: 'literal', value: '-' },
      { type: 'cmd', command: 'security find-generic-password -w -s aio' },
    ]);
  });

  it('resolves literal and env tokens from trusted settings without blocking secret-shaped env names', async () => {
    await expect(
      resolveTrustedConfigValue('Bearer ${env:AIO_AUX_API_KEY}', {
        cwd: process.cwd(),
        allowCommand: false,
        env: { AIO_AUX_API_KEY: 'sk-test-secret' },
      }),
    ).resolves.toBe('Bearer sk-test-secret');
  });

  it('resolves relative file tokens and trims trailing newlines used by secret files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aio-trusted-config-'));
    await writeFile(path.join(dir, 'secret.txt'), 'file-secret\n', 'utf8');

    await expect(
      resolveTrustedConfigValue('${file:secret.txt}', {
        cwd: dir,
        allowCommand: false,
      }),
    ).resolves.toBe('file-secret');
  });

  it('rejects command tokens unless the trusted settings call site enables commands', async () => {
    await expect(
      resolveTrustedConfigValue('${cmd:security find-generic-password -w -s aio}', {
        cwd: process.cwd(),
        allowCommand: false,
      }),
    ).rejects.toThrow(/command resolution is disabled/i);
  });

  it('rejects malformed trusted token expressions instead of treating them as literal secrets', async () => {
    await expect(
      resolveTrustedConfigValue('${cmd:security find-generic-password -w -s aio', {
        cwd: process.cwd(),
        allowCommand: true,
      }),
    ).rejects.toThrow(/malformed trusted config token/i);
  });

  it('runs allowlisted commands without a shell and trims trailing output newlines', async () => {
    const invocations: TrustedCommandInvocation[] = [];
    const runCommand = vi.fn(async (invocation: TrustedCommandInvocation) => {
      invocations.push(invocation);
      return { stdout: 'cmd-secret\n', stderr: '', exitCode: 0 };
    });

    await expect(
      resolveTrustedConfigValue('${cmd:security find-generic-password -w -s "AIO Aux"}', {
        cwd: process.cwd(),
        allowCommand: true,
        runCommand,
      }),
    ).resolves.toBe('cmd-secret');

    expect(invocations).toEqual([
      {
        executable: 'security',
        args: ['find-generic-password', '-w', '-s', 'AIO Aux'],
        cwd: process.cwd(),
        timeoutMs: expect.any(Number),
        maxOutputBytes: expect.any(Number),
      },
    ]);
  });

  it('rejects commands outside the default password-manager allowlist', async () => {
    const runCommand = vi.fn(async () => ({ stdout: 'unsafe', stderr: '', exitCode: 0 }));

    await expect(
      resolveTrustedConfigValue('${cmd:sh -c "echo unsafe"}', {
        cwd: process.cwd(),
        allowCommand: true,
        runCommand,
      }),
    ).rejects.toThrow(/not allowlisted/i);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('bounds command output before returning it', async () => {
    await expect(
      resolveTrustedConfigValue('${cmd:security find-generic-password -w -s aio}', {
        cwd: process.cwd(),
        allowCommand: true,
        maxOutputBytes: 4,
        runCommand: async () => ({ stdout: 'secret-value', stderr: '', exitCode: 0 }),
      }),
    ).resolves.toBe('secr');
  });

  it('times out slow command resolvers without exposing stdout or stderr in the error', async () => {
    await expect(
      resolveTrustedConfigValue('${cmd:security find-generic-password -w -s aio}', {
        cwd: process.cwd(),
        allowCommand: true,
        timeoutMs: 1,
        runCommand: () => new Promise(() => undefined),
      }),
    ).rejects.toThrow(/timed out after 1ms/i);
  });
});
