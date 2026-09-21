import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  NodeExecParams,
  NodeExecResult,
} from '../main/remote-node/node-control-rpc-schemas';
import { RPC_ERROR_CODES } from '../main/remote-node/worker-node-rpc';
import {
  execFileCaptureWithBoundedTermination,
  WorkerNodeExecutor,
} from './worker-node-executor';
import { WorkerRpcDispatcher } from './worker-rpc-dispatcher';
import { ExecFileError } from './service/exec-file';
import type { RpcMessage } from './worker-rpc-types';
import {
  buildWindowsAclInspectionScript,
  resolveTrustedNodeExecExecutable,
} from './worker-node-command-resolver';

const SCRIPT_LIMIT_BYTES = 256 * 1024;
const TRUSTED_WINDOWS_CURL = 'C:\\Windows\\System32\\curl.exe';
const TRUSTED_WINDOWS_POWERSHELL =
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const TRUSTED_INSTALLER_SID =
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

async function fixture(): Promise<{ allowed: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), 'aio-node-exec-policy-'));
  fixtureRoots.push(root);
  const allowed = join(root, 'allowed');
  const outside = join(root, 'outside');
  await Promise.all([mkdir(allowed), mkdir(outside)]);
  return { allowed, outside };
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function paramsWithScript(
  scriptPath: string,
  digest: string | undefined,
  args: string[] = [],
): NodeExecParams {
  return {
    executable: 'powershell.exe',
    args: ['-NoProfile', '-File', scriptPath, ...args],
    timeoutMs: 5_000,
    ...(digest ? { scriptSha256: digest } : {}),
  } as unknown as NodeExecParams;
}

function successfulRun(stdout = '') {
  return vi.fn(async (
    _file?: string,
    _args?: string[],
    _options?: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number },
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> => ({ exitCode: 0, stdout, stderr: '' }));
}

function trustedFixtureExecutable(requestedExecutable: string): Promise<string> {
  const basename = requestedExecutable.replace(/\\/gu, '/').split('/').at(-1)?.toLowerCase();
  if (basename === 'curl' || basename === 'curl.exe') {
    return Promise.resolve(TRUSTED_WINDOWS_CURL);
  }
  if (basename === 'taskkill' || basename === 'taskkill.exe') {
    return Promise.resolve('C:\\Windows\\System32\\taskkill.exe');
  }
  if (basename === 'powershell' || basename === 'powershell.exe') {
    return Promise.resolve(TRUSTED_WINDOWS_POWERSHELL);
  }
  return Promise.reject(new Error('fixture executable is not registered'));
}

function policyExecutor(
  roots: ConstructorParameters<typeof WorkerNodeExecutor>[0],
  run: ConstructorParameters<typeof WorkerNodeExecutor>[1],
  resolveTrustedExecutable = trustedFixtureExecutable,
): WorkerNodeExecutor {
  return new WorkerNodeExecutor(roots, run, Date.now, {
    platform: 'win32',
    spawnProcess: spawn,
    execFileProcess: execFile,
    killProcess: vi.fn(() => true),
    resolveTrustedExecutable,
  });
}

function secureWindowsAclRecords(executablePath: string, parentPath: string) {
  return [executablePath, parentPath].map((path) => ({
    daclNull: false,
    daclPresent: true,
    path,
    ownerSid: TRUSTED_INSTALLER_SID,
    rules: [{ appliesToObject: true, sid: 'S-1-5-32-545', type: 'Allow', rights: 0 }],
  }));
}

function windowsPowerShellResolver(records: unknown[]) {
  const parentPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0';
  return (requestedExecutable: string) => resolveTrustedNodeExecExecutable(
    requestedExecutable,
    {
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' },
      lstatPath: async (candidate) => ({
        isFile: () => candidate === TRUSTED_WINDOWS_POWERSHELL,
        isDirectory: () => candidate === parentPath,
        isSymbolicLink: () => false,
        uid: 0,
        mode: 0,
      }),
      realpathPath: async (candidate) => candidate,
      inspectWindowsAcl: async () => records,
    },
  );
}

function windowsCommandResolver(
  requestedExecutable: string,
  expectedExecutable: string,
  records: unknown[],
) {
  const parentPath = win32.dirname(expectedExecutable);
  return resolveTrustedNodeExecExecutable(requestedExecutable, {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' },
    lstatPath: async (candidate) => ({
      isFile: () => candidate === expectedExecutable || candidate === TRUSTED_WINDOWS_POWERSHELL,
      isDirectory: () => candidate === parentPath,
      isSymbolicLink: () => false,
      uid: 0,
      mode: 0,
    }),
    realpathPath: async (candidate) => candidate,
    inspectWindowsAcl: async () => records,
  });
}

describe('trusted node.exec command resolution', () => {
  it.each([
    ['powershell.exe', TRUSTED_WINDOWS_POWERSHELL],
    ['curl.exe', TRUSTED_WINDOWS_CURL],
    ['taskkill.exe', 'C:\\Windows\\System32\\taskkill.exe'],
  ])('maps Windows %s to its validated SystemRoot executable', async (requested, expected) => {
    const inspected: string[] = [];
    const parentPath = win32.dirname(expected);
    const inspectWindowsAcl = vi.fn(async () => secureWindowsAclRecords(expected, parentPath));
    const resolved = await resolveTrustedNodeExecExecutable(requested, {
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' },
      lstatPath: async (candidate) => {
        inspected.push(candidate);
        return {
          isFile: () => candidate === expected || candidate === TRUSTED_WINDOWS_POWERSHELL,
          isDirectory: () => candidate === parentPath,
          isSymbolicLink: () => false,
          mode: 0,
          uid: 0,
        };
      },
      realpathPath: async (candidate) => candidate,
      inspectWindowsAcl,
    });

    expect(resolved).toBe(expected);
    expect(inspected).toEqual(
      expected === TRUSTED_WINDOWS_POWERSHELL
        ? [expected, parentPath]
        : [expected, parentPath, TRUSTED_WINDOWS_POWERSHELL],
    );
    expect(inspectWindowsAcl).toHaveBeenCalledWith(
      expected,
      parentPath,
      TRUSTED_WINDOWS_POWERSHELL,
      'C:\\Windows',
    );
  });

  it('rejects a symlink or non-root-owned POSIX curl instead of resolving through it', async () => {
    const common = {
      platform: 'linux' as const,
      env: {},
      realpathPath: async (candidate: string) => candidate,
    };
    await expect(resolveTrustedNodeExecExecutable('curl', {
      ...common,
      lstatPath: async (candidate: string) => ({
        isFile: () => candidate === '/usr/bin/curl',
        isDirectory: () => candidate === '/usr/bin',
        isSymbolicLink: () => candidate === '/usr/bin/curl',
        mode: 0o100755,
        uid: 0,
      }),
    })).rejects.toThrow(/regular non-symlink/i);
    await expect(resolveTrustedNodeExecExecutable('curl', {
      ...common,
      lstatPath: async (candidate: string) => ({
        isFile: () => candidate === '/usr/bin/curl',
        isDirectory: () => candidate === '/usr/bin',
        isSymbolicLink: () => false,
        mode: 0o100755,
        uid: 501,
      }),
    })).rejects.toThrow(/owned by root/i);
  });

  it('rejects an environment-supplied Windows directory outside the system location', async () => {
    const inspect = vi.fn();
    await expect(resolveTrustedNodeExecExecutable('powershell.exe', {
      platform: 'win32',
      env: { SystemRoot: 'C:\\work\\Windows', WINDIR: 'C:\\work\\Windows' },
      lstatPath: inspect,
      realpathPath: inspect,
    })).rejects.toThrow(/trusted system location/i);
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([
    ['group-writable executable', 0o100775, 0o040755],
    ['world-writable executable', 0o100757, 0o040755],
    ['group-writable parent', 0o100755, 0o040775],
    ['world-writable parent', 0o100755, 0o040757],
  ])('rejects a root-owned POSIX curl with an unstable %s', async (
    _caseName,
    executableMode,
    parentMode,
  ) => {
    await expect(resolveTrustedNodeExecExecutable('curl', {
      platform: 'linux',
      env: {},
      lstatPath: async (candidate: string) => ({
        isFile: () => candidate === '/usr/bin/curl',
        isDirectory: () => candidate === '/usr/bin',
        isSymbolicLink: () => false,
        uid: 0,
        mode: candidate === '/usr/bin/curl' ? executableMode : parentMode,
      }),
      realpathPath: async (candidate: string) => candidate,
    } as never)).rejects.toThrow(/writable|stable system/i);
  });

  it.each([
    ['untrusted executable owner', 'owner', false],
    ['write-capable untrusted executable principal', 'rule', false],
    ['write-capable untrusted parent principal', 'rule', true],
    ['malformed ACL response', 'malformed', false],
    ['mismatched ACL path', 'path', false],
    ['ACL inspector failure', 'failure', false],
  ])('rejects Windows resolution for %s', async (_caseName, failure, mutateParent) => {
    const parentPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0';
    const records = secureWindowsAclRecords(TRUSTED_WINDOWS_POWERSHELL, parentPath);
    const target = records[mutateParent ? 1 : 0];
    if (failure === 'owner' && target) target.ownerSid = 'S-1-5-21-1-2-3-1001';
    if (failure === 'path' && target) target.path = 'C:\\Windows\\Temp\\powershell.exe';
    if (failure === 'rule' && target) target.rules[0] = {
      appliesToObject: true,
      sid: 'S-1-5-32-545',
      type: 'Allow',
      rights: 2,
    };
    const inspectWindowsAcl = failure === 'failure'
      ? vi.fn(async () => { throw new Error('inspection unavailable'); })
      : vi.fn(async () => failure === 'malformed' ? { unexpected: true } : records);

    await expect(resolveTrustedNodeExecExecutable('powershell.exe', {
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' },
      lstatPath: async (candidate: string) => ({
        isFile: () => candidate === TRUSTED_WINDOWS_POWERSHELL,
        isDirectory: () => candidate === parentPath,
        isSymbolicLink: () => false,
        uid: 0,
        mode: 0,
      }),
      realpathPath: async (candidate: string) => candidate,
      inspectWindowsAcl,
    } as never)).rejects.toThrow(/ACL|owner|writable|inspection/i);
  });

  it.each([
    ['candidate GENERIC_WRITE', 0, 0x40000000],
    ['parent GENERIC_WRITE', 1, 0x40000000],
    ['candidate GENERIC_ALL', 0, 0x10000000],
    ['parent GENERIC_ALL', 1, 0x10000000],
    ['candidate MAXIMUM_ALLOWED', 0, 0x02000000],
    ['parent MAXIMUM_ALLOWED', 1, 0x02000000],
  ])('rejects an untrusted Windows principal with %s', async (_caseName, targetIndex, rights) => {
    const parentPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0';
    const records = secureWindowsAclRecords(TRUSTED_WINDOWS_POWERSHELL, parentPath);
    const target = records[targetIndex];
    if (!target) throw new Error('invalid test fixture target');
    target.rules[0] = {
      appliesToObject: true,
      sid: 'S-1-5-32-545',
      type: 'Allow',
      rights,
    };

    await expect(windowsPowerShellResolver(records)('powershell.exe'))
      .rejects.toThrow(/writable|access rights/i);
  });

  it.each([
    ['absent candidate DACL', 0, false, false, false],
    ['absent parent DACL', 1, false, false, false],
    ['NULL candidate DACL', 0, true, true, false],
    ['NULL parent DACL', 1, true, true, false],
    ['missing candidate DACL state', 0, true, false, true],
    ['malformed parent DACL state', 1, true, false, false],
  ])('rejects %s', async (_caseName, targetIndex, daclPresent, daclNull, omitState) => {
    const parentPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0';
    const records = secureWindowsAclRecords(TRUSTED_WINDOWS_POWERSHELL, parentPath);
    const target = records[targetIndex] as Record<string, unknown> | undefined;
    if (!target) throw new Error('invalid test fixture target');
    if (omitState) {
      delete target['daclPresent'];
      delete target['daclNull'];
    } else {
      target['daclPresent'] = daclPresent;
      target['daclNull'] = _caseName.startsWith('malformed') ? 'unknown' : daclNull;
    }

    await expect(windowsPowerShellResolver(records)('powershell.exe'))
      .rejects.toThrow(/DACL|malformed/i);
  });

  it('distinguishes and accepts an explicit empty DACL on both trusted paths', async () => {
    const parentPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0';
    const records = secureWindowsAclRecords(TRUSTED_WINDOWS_POWERSHELL, parentPath);
    records[0]!.rules = [];
    records[1]!.rules = [];

    await expect(windowsPowerShellResolver(records)('powershell.exe'))
      .resolves.toBe(TRUSTED_WINDOWS_POWERSHELL);
  });

  it('serializes signed FileSystemRights enums as exact unsigned 32-bit access masks', () => {
    const inspectorEquivalentSignedReadWrite = -1_073_741_824;
    expect(inspectorEquivalentSignedReadWrite >>> 0).toBe(0xc0000000);

    expect(buildWindowsAclInspectionScript(
      TRUSTED_WINDOWS_POWERSHELL,
      win32.dirname(TRUSTED_WINDOWS_POWERSHELL),
    )).toContain('rights=([int64]$_.FileSystemRights -band 0xffffffffL)');
  });

  it('never puts a statement separator immediately after an opening hash literal', () => {
    const script = buildWindowsAclInspectionScript(
      TRUSTED_WINDOWS_POWERSHELL,
      win32.dirname(TRUSTED_WINDOWS_POWERSHELL),
    );

    // The shipped bug: joining every line with ';' produced `@{;daclPresent=`,
    // which PowerShell rejects as "The hash literal was incomplete". The child
    // exited 1 with empty stdout and every exec_on_node call on Windows died in
    // inspectWindowsAcl's catch-all. Asserting on a substring of the script (as
    // the test above does) cannot catch a syntax error, so assert the shape
    // that was actually wrong.
    expect(script).not.toMatch(/@\{\s*;/u);

    // Every `@{` must be followed by a key, a newline, or a closing brace —
    // never by a bare separator.
    for (const match of script.matchAll(/@\{(.)/gu)) {
      expect(match[1]).not.toBe(';');
    }

    // And the opener must genuinely end its line, which is what makes the
    // multi-line hash literal parse.
    expect(script.split('\n')).toContain('[pscustomobject]@{');
  });

  it.each([
    ['untrusted read-only candidate', 'powershell.exe', TRUSTED_WINDOWS_POWERSHELL, 0, 'S-1-5-32-545', 0x80000000, false],
    ['trusted read/write candidate', 'powershell.exe', TRUSTED_WINDOWS_POWERSHELL, 0, TRUSTED_INSTALLER_SID, 0xc0000000, false],
    ['untrusted read/write candidate', 'powershell.exe', TRUSTED_WINDOWS_POWERSHELL, 0, 'S-1-5-32-545', 0xc0000000, true],
    ['untrusted read/write parent', 'powershell.exe', TRUSTED_WINDOWS_POWERSHELL, 1, 'S-1-5-32-545', 0xc0000000, true],
    ['untrusted read/write taskkill', 'taskkill.exe', 'C:\\Windows\\System32\\taskkill.exe', 0, 'S-1-5-32-545', 0xc0000000, true],
  ])('handles unsigned bit-31 rights for %s', async (
    _caseName,
    requestedExecutable,
    expectedExecutable,
    targetIndex,
    sid,
    rights,
    rejects,
  ) => {
    const records = secureWindowsAclRecords(
      expectedExecutable,
      win32.dirname(expectedExecutable),
    );
    const target = records[targetIndex];
    if (!target) throw new Error('invalid test fixture target');
    target.rules[0] = {
      appliesToObject: true,
      sid,
      type: 'Allow',
      rights,
    };
    const resolution = windowsCommandResolver(requestedExecutable, expectedExecutable, records);

    if (rejects) {
      await expect(resolution).rejects.toThrow(/writable/i);
    } else {
      await expect(resolution).resolves.toBe(expectedExecutable);
    }
  });
});

describe('WorkerNodeExecutor PowerShell file policy', () => {
  it('denies an exact hash-bound browser launcher script before child spawn', async () => {
    const { allowed } = await fixture();
    const script = 'Start-Process chrome.exe "chrome://extensions/"';
    const scriptPath = join(allowed, 'recover.ps1');
    await writeFile(scriptPath, script);
    const run = successfulRun();
    const executor = policyExecutor([allowed], run);

    await expect(executor.execute(paramsWithScript(scriptPath, sha256(script))))
      .rejects.toThrow(/launch or drive.*shared/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('denies common PowerShell launcher obfuscation before child spawn', async () => {
    const { allowed } = await fixture();
    const script = 'S`tart-Process ("ch" + "rome.exe") "https://example.invalid"';
    const scriptPath = join(allowed, 'obfuscated.ps1');
    await writeFile(scriptPath, script);
    const run = successfulRun();
    const executor = policyExecutor([allowed], run);

    await expect(executor.execute(paramsWithScript(scriptPath, sha256(script))))
      .rejects.toThrow(/launch or drive.*shared/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('executes safe verified bytes through PowerShell stdin without snapshot files', async () => {
    const { allowed } = await fixture();
    const script = 'Write-Output "safe worker"';
    const scriptPath = join(allowed, 'safe.ps1');
    await writeFile(scriptPath, script);
    const run = vi.fn(async (_file: string, args: string[], options = {}) => {
      const fileIndex = args.findIndex((arg) => arg.toLowerCase() === '-file');
      expect(args[fileIndex + 1]).toBe('-');
      expect(args.slice(fileIndex + 2)).toEqual(['first', 'second']);
      expect(options).toMatchObject({ input: script });
      expect((await readdir(allowed)).sort()).toEqual(['safe.ps1']);
      return { exitCode: 0, stdout: 'safe worker\n', stderr: '' };
    });
    const executor = policyExecutor([allowed], run);

    const result = await executor.execute(paramsWithScript(
      scriptPath,
      sha256(script),
      ['first', 'second'],
    ));

    expect(result).toMatchObject({ exitCode: 0, stdout: 'safe worker\n' });
    expect((await readdir(allowed)).sort()).toEqual(['safe.ps1']);
  });

  it('runs the bound in-memory bytes when the original path changes after validation', async () => {
    const { allowed } = await fixture();
    const safeScript = 'Write-Output "bound content"';
    const scriptPath = join(allowed, 'mutable.ps1');
    await writeFile(scriptPath, safeScript);
    const run = vi.fn(async (_file: string, args: string[], options = {}) => {
      await writeFile(scriptPath, 'Start-Process chrome.exe "https://example.invalid"');
      expect(args[args.findIndex((arg) => arg.toLowerCase() === '-file') + 1]).toBe('-');
      expect(options).toMatchObject({ input: safeScript });
      return { exitCode: 0, stdout: 'bound content\n', stderr: '' };
    });
    const executor = policyExecutor([allowed], run);

    await expect(executor.execute(paramsWithScript(scriptPath, sha256(safeScript))))
      .resolves.toMatchObject({ exitCode: 0, stdout: 'bound content\n' });
  });

  it.each(['close', 'error'] as const)(
    'routes premature stdin %s through bounded Windows tree cleanup',
    async (failureKind) => {
    const { allowed } = await fixture();
    const script = 'Write-Output "safe"';
    const scriptPath = join(allowed, 'stdin-error.ps1');
    await writeFile(scriptPath, script);
    const stdin = Object.assign(new EventEmitter(), {
      end: vi.fn(() => queueMicrotask(() => stdin.emit(
        failureKind,
        ...(failureKind === 'error' ? [new Error('fixture stdin failure')] : []),
      ))),
      destroy: vi.fn(),
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 31_337,
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    }) as unknown as ChildProcess;
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const taskkillFiles: string[] = [];
    const taskkillArgs: string[][] = [];
    const execFileProcess = ((...values: unknown[]) => {
      taskkillFiles.push(values[0] as string);
      taskkillArgs.push(values[1] as string[]);
      const callback = values[3] as (error: Error | null, stdout: string, stderr: string) => void;
      queueMicrotask(() => callback(null, '', ''));
      return { kill: vi.fn(), unref: vi.fn() };
    }) as unknown as typeof execFile;
    const executor = new WorkerNodeExecutor([allowed], undefined, Date.now, {
      platform: 'win32',
      spawnProcess,
      execFileProcess,
      killProcess: vi.fn(() => true),
      resolveTrustedExecutable: trustedFixtureExecutable,
    });

    const result = await executor.execute(paramsWithScript(scriptPath, sha256(script)));

    expect(result).toMatchObject({
      exitCode: null,
      stderr: expect.stringMatching(/verified script input.*(?:closed|fixture stdin failure)/i),
    });
    expect(taskkillArgs).toEqual([
      ['/PID', '31337', '/T'],
      ['/PID', '31337', '/T', '/F'],
    ]);
    expect(taskkillFiles).toEqual([
      'C:\\Windows\\System32\\taskkill.exe',
      'C:\\Windows\\System32\\taskkill.exe',
    ]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('waits for stdin finish and accepts close only after complete delivery', async () => {
    const { allowed } = await fixture();
    const script = 'Write-Output "safe"';
    const scriptPath = join(allowed, 'stdin-finish.ps1');
    await writeFile(scriptPath, script);
    const stdin = Object.assign(new EventEmitter(), {
      end: vi.fn(() => {
        setTimeout(() => {
          stdin.emit('finish');
          stdin.emit('close');
          child.emit('close', 0, null);
        }, 20);
        return false;
      }),
      destroy: vi.fn(),
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 31_338,
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    }) as unknown as ChildProcess;
    const executor = new WorkerNodeExecutor([allowed], undefined, Date.now, {
      platform: 'win32',
      spawnProcess: vi.fn(() => child) as unknown as typeof spawn,
      execFileProcess: execFile,
      killProcess: vi.fn(() => true),
      resolveTrustedExecutable: trustedFixtureExecutable,
    });

    await expect(executor.execute(paramsWithScript(scriptPath, sha256(script))))
      .resolves.toMatchObject({ exitCode: 0, stderr: '' });
  });

  it('reports cleanupIncomplete when stdin fails and Windows tree cleanup cannot signal', async () => {
    const { allowed } = await fixture();
    const script = 'Write-Output "safe"';
    const scriptPath = join(allowed, 'stdin-cleanup.ps1');
    await writeFile(scriptPath, script);
    const stdin = Object.assign(new EventEmitter(), {
      end: vi.fn(() => queueMicrotask(() => stdin.emit('error', new Error('write failed')))),
      destroy: vi.fn(),
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 31_339,
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => false),
      unref: vi.fn(),
    }) as unknown as ChildProcess;
    const execFileProcess = ((...values: unknown[]) => {
      const callback = values[3] as (error: Error, stdout: string, stderr: string) => void;
      queueMicrotask(() => callback(Object.assign(new Error('missing'), { code: 'ENOENT' }), '', ''));
      return { kill: vi.fn(), unref: vi.fn() };
    }) as unknown as typeof execFile;
    const killProcess = vi.fn(() => false);
    const executor = new WorkerNodeExecutor([allowed], undefined, Date.now, {
      platform: 'win32',
      spawnProcess: vi.fn(() => child) as unknown as typeof spawn,
      execFileProcess,
      killProcess,
      resolveTrustedExecutable: trustedFixtureExecutable,
    });

    const result = await executor.execute(paramsWithScript(scriptPath, sha256(script)));

    expect(result.exitCode).toBeNull();
    expect(result.stderr).toMatch(/verified script input.*write failed/i);
    expect(result.stderr).toMatch(/cleanup.*taskkill SIGTERM failed.*fallback failed/i);
    expect(result.stderr).toMatch(/cleanup.*taskkill SIGKILL failed.*fallback failed/i);
    expect(killProcess).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform === 'win32')(
    'terminates a real descendant after premature script-input closure',
    async () => {
      const { allowed } = await fixture();
      const childPidPath = join(allowed, 'stdin-descendant.pid');
      const heartbeatPath = join(allowed, 'stdin-descendant.heartbeat');
      const wrapperPath = join(allowed, 'powershell.exe');
      await writeFile(wrapperPath, [
        '#!/usr/bin/env node',
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'const child = spawn(process.execPath, ["-e",',
        `  'const {writeFileSync}=require("node:fs");let n=0;setInterval(()=>writeFileSync(${JSON.stringify(heartbeatPath)},String(++n)),25)'`,
        '], { stdio: "ignore", env: process.env });',
        `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
        'require("node:fs").closeSync(0);',
        'setInterval(() => {}, 1_000);',
      ].join('\n'));
      await chmod(wrapperPath, 0o755);
      let descendantPid: number | undefined;

      try {
        const execution = execFileCaptureWithBoundedTermination(
          wrapperPath,
          [],
          { input: 'x'.repeat(8 * 1024 * 1024), timeoutMs: 2_000 },
        );
        let failure: ExecFileError | undefined;
        try {
          await execution;
        } catch (error) {
          failure = error as ExecFileError;
        }
        expect(failure?.stderr).toMatch(/verified script input/i);
        expect(failure?.stderr).not.toMatch(/cleanupIncomplete/i);
        descendantPid = Number.parseInt(await readFile(childPidPath, 'utf8'), 10);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const heartbeatAfterCleanup = await readFile(heartbeatPath, 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await readFile(heartbeatPath, 'utf8')).toBe(heartbeatAfterCleanup);
      } finally {
        if (descendantPid !== undefined) {
          try {
            process.kill(descendantPid, 'SIGKILL');
          } catch {
            // Expected when bounded ownership-aware cleanup succeeded.
          }
        }
      }
    },
    10_000,
  );

  it('preserves non-zero exit and stderr for a verified stdin script', async () => {
    const { allowed } = await fixture();
    const script = 'Write-Error "expected"; exit 7';
    const scriptPath = join(allowed, 'nonzero.ps1');
    await writeFile(scriptPath, script);
    const run = vi.fn(async (_file: string, args: string[], options = {}) => {
      expect(args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-File', '-']);
      expect(options).toMatchObject({ input: script });
      throw new ExecFileError('powershell.exe', args, 7, null, '', 'expected failure');
    });
    const executor = policyExecutor([allowed], run);

    await expect(executor.execute(paramsWithScript(scriptPath, sha256(script))))
      .resolves.toMatchObject({ exitCode: 7, stderr: 'expected failure' });
  });

  it.each([
    ['UTF-8 BOM', Buffer.from('\ufeffWrite-Output "utf8"', 'utf8'), 'Write-Output "utf8"'],
    ['UTF-16 LE BOM', Buffer.concat([
      Buffer.from([0xff, 0xfe]), Buffer.from('Write-Output "utf16le"', 'utf16le'),
    ]), 'Write-Output "utf16le"'],
    ['UTF-16 BE BOM', Buffer.from([
      0xfe, 0xff, ...Buffer.from('Write-Output "utf16be"', 'utf16le')
        .reduce<number[]>((bytes, byte, index, all) => (
          index % 2 === 0 ? [...bytes, all[index + 1] ?? 0, byte] : bytes
        ), []),
    ]), 'Write-Output "utf16be"'],
  ])('decodes and re-encodes %s scripts as stdin text', async (_label, bytes, expected) => {
    const { allowed } = await fixture();
    const scriptPath = join(allowed, 'encoded.ps1');
    await writeFile(scriptPath, bytes);
    const run = successfulRun();
    const executor = policyExecutor([allowed], run);

    await executor.execute(paramsWithScript(scriptPath, sha256(bytes)));

    expect(run).toHaveBeenCalledWith(
      TRUSTED_WINDOWS_POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', '-'],
      expect.objectContaining({ input: expected }),
    );
  });

  it.each([
    ['Write-Output $PSScriptRoot', /path-dependent/i],
    ['Write-Output $MyInvocation.MyCommand.Path', /path-dependent/i],
    ['Write-Output ${PSScriptRoot}', /path-dependent/i],
    ['Write-Output ${script:PSCommandPath}', /path-dependent/i],
    ['Write-Output ${global:MyInvocation}', /path-dependent/i],
    ['Write-Output ${using:PSScriptRoot}', /path-dependent/i],
    ['Write-Output $script:PSScriptRoot', /path-dependent/i],
    ['Write-Output ${PS`ScriptRoot}', /path-dependent/i],
    ['Write-Output $script:PS`CommandPath', /path-dependent/i],
    ['& .\\sibling.ps1', /launch|drive|policy/i],
    ["$x='Start-Process'; & $x chrome.exe", /launch|drive|policy/i],
  ])('fails closed for unsupported or dynamic stdin script: %s', async (script, message) => {
    const { allowed } = await fixture();
    const scriptPath = join(allowed, 'unsupported.ps1');
    await writeFile(scriptPath, script);
    const run = successfulRun();
    const executor = policyExecutor([allowed], run);

    await expect(executor.execute(paramsWithScript(scriptPath, sha256(script))))
      .rejects.toThrow(message);
    expect(run).not.toHaveBeenCalled();
  });

  it('allows an escaped literal path-metadata name in a verified script', async () => {
    const { allowed } = await fixture();
    const script = 'Write-Output `$PSScriptRoot';
    const scriptPath = join(allowed, 'literal-metadata.ps1');
    await writeFile(scriptPath, script);
    const run = successfulRun('literal\n');
    const executor = policyExecutor([allowed], run);

    await expect(executor.execute(paramsWithScript(scriptPath, sha256(script))))
      .resolves.toMatchObject({ stdout: 'literal\n' });
  });

  it('fails closed when the required transfer hash is missing or stale', async () => {
    const { allowed } = await fixture();
    const script = 'Write-Output "safe"';
    const scriptPath = join(allowed, 'changed.ps1');
    await writeFile(scriptPath, script);
    const run = successfulRun();
    const executor = policyExecutor([allowed], run);

    await expect(executor.execute(paramsWithScript(scriptPath, undefined)))
      .rejects.toThrow(/scriptSha256/i);
    await expect(executor.execute(paramsWithScript(scriptPath, 'a'.repeat(64))))
      .rejects.toThrow(/hash|sha-256|changed/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('fails closed for outside-root and symlink-escape scripts', async () => {
    const { allowed, outside } = await fixture();
    const script = 'Write-Output "safe"';
    const outsidePath = join(outside, 'outside.ps1');
    const linkPath = join(allowed, 'escape.ps1');
    await writeFile(outsidePath, script);
    await symlink(outsidePath, linkPath);
    const run = successfulRun();
    const executor = policyExecutor([allowed], run);

    await expect(executor.execute(paramsWithScript(outsidePath, sha256(script))))
      .rejects.toThrow(/outside configured worker/i);
    await expect(executor.execute(paramsWithScript(linkPath, sha256(script))))
      .rejects.toThrow(/outside configured worker/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('fails closed for an oversized script before child spawn', async () => {
    const { allowed } = await fixture();
    const script = Buffer.alloc(SCRIPT_LIMIT_BYTES + 1, 0x20);
    const scriptPath = join(allowed, 'oversized.ps1');
    await writeFile(scriptPath, script);
    const run = successfulRun();
    const executor = policyExecutor([allowed], run);

    await expect(executor.execute(paramsWithScript(scriptPath, sha256(script))))
      .rejects.toThrow(/too large|exceeds/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a directory before attempting to open it as script content', async () => {
    const { allowed } = await fixture();
    const directoryPath = join(allowed, 'directory.ps1');
    await mkdir(directoryPath);
    const run = successfulRun();
    const executor = policyExecutor([allowed], run);

    await expect(executor.execute(paramsWithScript(directoryPath, 'a'.repeat(64))))
      .rejects.toThrow(/regular file|non-regular/i);
    expect(run).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'rejects FIFO and socket script paths promptly without blocking on open',
    async () => {
      const { allowed } = await fixture();
      const fifoPath = join(allowed, 'pipe.ps1');
      const socketPath = join(allowed, 'socket.ps1');
      await new Promise<void>((resolve, reject) => {
        execFile('mkfifo', [fifoPath], (error) => error ? reject(error) : resolve());
      });
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      const run = successfulRun();
      const executor = policyExecutor([allowed], run);

      try {
        for (const scriptPath of [fifoPath, socketPath]) {
          await expect(Promise.race([
            executor.execute(paramsWithScript(scriptPath, 'a'.repeat(64))),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error('script preparation blocked')), 500);
            }),
          ])).rejects.toThrow(/regular file|non-regular/i);
        }
        expect(run).not.toHaveBeenCalled();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it('resolves a relative script against cwd and accepts a dynamic writable root', async () => {
    const { allowed } = await fixture();
    const script = 'Write-Output "safe"';
    const scriptPath = join(allowed, 'relative.ps1');
    await writeFile(scriptPath, script);
    const run = successfulRun('safe\n');
    let roots: readonly string[] = [];
    const executor = policyExecutor(() => roots, run);
    roots = [allowed];
    const params = paramsWithScript('relative.ps1', sha256(script));
    params.cwd = allowed;

    await expect(executor.execute(params)).resolves.toMatchObject({ stdout: 'safe\n' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not reinterpret a later fake -File token after a positional command', async () => {
    const run = successfulRun('hello\n');
    const executor = policyExecutor([process.cwd()], run);
    const params = {
      executable: 'powershell.exe',
      args: ['Write-Output', 'hello', '-File', 'ignored.ps1'],
      timeoutMs: 5_000,
    };

    await expect(executor.execute(params)).resolves.toMatchObject({ stdout: 'hello\n' });
    expect(run).toHaveBeenCalledWith(
      TRUSTED_WINDOWS_POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Write-Output hello -File ignored.ps1'],
      expect.objectContaining({ timeoutMs: params.timeoutMs, env: expect.any(Object) }),
    );
  });

  it('resolves a relative script against PowerShell -WorkingDirectory', async () => {
    const { allowed } = await fixture();
    const script = 'Write-Output "working directory"';
    await writeFile(join(allowed, 'relative.ps1'), script);
    const run = successfulRun('working directory\n');
    const executor = policyExecutor([allowed], run);
    const params = paramsWithScript('relative.ps1', sha256(script));
    params.args = [
      '-NoProfile', '-WorkingDirectory', allowed, '-File', 'relative.ps1',
    ];

    await expect(executor.execute(params)).resolves.toMatchObject({
      stdout: 'working directory\n',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('worker node.exec browser-launch policy', () => {
  it.each([
    [
      'powershell.exe',
      ['-Command', 'Write-Output "fixture"'],
      TRUSTED_WINDOWS_POWERSHELL,
    ],
    [
      'curl.exe',
      ['https://example.invalid/data'],
      TRUSTED_WINDOWS_CURL,
    ],
  ])('ignores a caller-cwd %s shadow and spawns the trusted absolute system executable', async (
    executable,
    args,
    trustedExecutable,
  ) => {
    const { allowed } = await fixture();
    await writeFile(join(allowed, executable), 'malicious fixture shadow');
    const resolvedAllowed = await realpath(allowed);
    const run = successfulRun('safe');
    const resolveTrustedExecutable = vi.fn(async () => trustedExecutable);
    const executor = new WorkerNodeExecutor([allowed], run, Date.now, {
      platform: 'win32',
      spawnProcess: spawn,
      execFileProcess: execFile,
      killProcess: vi.fn(() => true),
      resolveTrustedExecutable,
    } as never);

    await executor.execute({ executable, args, cwd: allowed, timeoutMs: 5_000 });

    expect(run).toHaveBeenCalledWith(
      trustedExecutable,
      expect.any(Array),
      expect.objectContaining({ cwd: resolvedAllowed }),
    );
    expect(resolveTrustedExecutable).toHaveBeenCalledWith(executable);
  });

  it('fails closed before spawn when the trusted executable cannot be validated', async () => {
    const run = successfulRun();
    const executor = new WorkerNodeExecutor([process.cwd()], run, Date.now, {
      platform: 'win32',
      spawnProcess: spawn,
      execFileProcess: execFile,
      killProcess: vi.fn(() => true),
      resolveTrustedExecutable: vi.fn(async () => {
        throw new Error('trusted executable is missing or is a symlink');
      }),
    } as never);

    await expect(executor.execute({
      executable: 'powershell.exe',
      args: ['-Command', 'Write-Output "fixture"'],
      timeoutMs: 5_000,
    })).rejects.toThrow(/trusted executable.*missing|symlink/i);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ['GENERIC_WRITE on the candidate', 0, 0x40000000, true, false],
    ['NULL DACL on the parent', 1, 0, true, true],
  ])('rejects raw service RPC when Windows ACL inspection finds %s', async (
    _caseName,
    targetIndex,
    rights,
    daclPresent,
    daclNull,
  ) => {
    const parentPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0';
    const records = secureWindowsAclRecords(TRUSTED_WINDOWS_POWERSHELL, parentPath);
    const target = records[targetIndex];
    if (!target) throw new Error('invalid test fixture target');
    target.daclPresent = daclPresent;
    target.daclNull = daclNull;
    target.rules[0] = {
      appliesToObject: true,
      sid: 'S-1-5-32-545',
      type: 'Allow',
      rights,
    };
    const execute = successfulRun();
    const { dispatcher, sendResult, sendError } = makeDispatcher(
      execute,
      windowsPowerShellResolver(records),
    );

    await dispatcher.handleRpcRequest(request({
      executable: 'powershell.exe',
      args: ['-Command', 'Write-Output "fixture"'],
    }));

    expect(execute).not.toHaveBeenCalled();
    expect(sendResult).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledWith(
      73,
      RPC_ERROR_CODES.INVALID_PARAMS,
      expect.stringMatching(/ACL|DACL|writable/i),
    );
  });

  it('denies direct service RPC OS browser launchers before execution', async () => {
    const execute = successfulRun();
    const { dispatcher, sendResult, sendError } = makeDispatcher(execute);

    await dispatcher.handleRpcRequest(request({
      executable: 'cmd.exe',
      args: ['/c', 'start', '', 'https://example.invalid'],
    }));

    expect(execute).not.toHaveBeenCalled();
    expect(sendResult).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledWith(
      73,
      RPC_ERROR_CODES.INVALID_PARAMS,
      expect.stringMatching(/browser|shared Chrome/i),
    );
  });

  it('permits curl URLs with config disabled and a sanitized child environment', async () => {
    vi.stubEnv('NODE_OPTIONS', '--require=untrusted-hook');
    vi.stubEnv('BASH_ENV', '/tmp/untrusted-hook');
    vi.stubEnv('COMSPEC', 'C:\\tmp\\untrusted-cmd.exe');
    const execute = successfulRun('ok');
    const { dispatcher, sendResult, sendError } = makeDispatcher(execute);
    const params = {
      executable: 'curl',
      args: ['--fail', 'https://example.invalid/data'],
      timeoutMs: 5_000,
    };

    try {
      await dispatcher.handleRpcRequest(request(params));
    } finally {
      vi.unstubAllEnvs();
    }

    expect(sendError).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      TRUSTED_WINDOWS_CURL,
      ['--disable', ...params.args],
      expect.objectContaining({ timeoutMs: params.timeoutMs, env: expect.any(Object) }),
    );
    const options = execute.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(options.env).not.toHaveProperty('NODE_OPTIONS');
    expect(options.env).not.toHaveProperty('BASH_ENV');
    expect(options.env).not.toHaveProperty('COMSPEC');
    expect(sendResult).toHaveBeenCalledWith(73, expect.objectContaining({ stdout: 'ok' }));
  });

  it('permits and canonicalizes the literal-output PowerShell subgrammar', async () => {
    const execute = successfulRun('fixture');
    const { dispatcher, sendResult, sendError } = makeDispatcher(execute);
    const params = {
      executable: 'powershell.exe',
      args: ['-NoProfile', '-Command', 'Write-Output "fixture"'],
    };

    await dispatcher.handleRpcRequest(request(params));

    expect(sendError).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      TRUSTED_WINDOWS_POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Write-Output "fixture"'],
      expect.objectContaining({ timeoutMs: 30_000, env: expect.any(Object) }),
    );
    expect(sendResult).toHaveBeenCalledWith(73, expect.objectContaining({ stdout: 'fixture' }));
  });

  it('denies encoded PowerShell and nested PowerShell file wrappers', async () => {
    const execute = successfulRun();
    const { dispatcher, sendResult, sendError } = makeDispatcher(execute);

    await dispatcher.handleRpcRequest(request({
      executable: 'powershell.exe',
      args: ['-EncodedCommand', 'UwB0AGEAcgB0AC0AUAByAG8AYwBlAHMAcwA='],
    }));
    await dispatcher.handleRpcRequest(request({
      executable: 'cmd.exe',
      args: ['/c', 'powershell.exe', '-File', 'C:\\work\\script.ps1'],
      scriptSha256: 'b'.repeat(64),
    }));

    expect(execute).not.toHaveBeenCalled();
    expect(sendResult).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledTimes(2);
    expect(sendError).toHaveBeenNthCalledWith(
      1, 73, RPC_ERROR_CODES.INVALID_PARAMS, expect.stringMatching(/browser|shared Chrome/i),
    );
    expect(sendError).toHaveBeenNthCalledWith(
      2, 73, RPC_ERROR_CODES.INVALID_PARAMS, expect.stringMatching(/browser|shared Chrome/i),
    );
  });

  it.each([
    ['python.exe', ['-c', 'import subprocess; subprocess.Popen(["chrome.exe"])']],
    ['cmd.exe', ['/c', 'po^wershell.exe -F^ile C:\\work\\script.ps1']],
    ['cmd.exe', ['/c', 'po^wershell.exe -Encoded`Command AAAA']],
    ['powershell.exe', ['-Command', '& .\\unbound.ps1']],
    ['powershell.exe', ['-Command', "$x='Start-Process'; & $x chrome.exe"]],
    [
      'powershell.exe',
      ['-Command', "Start-Process $env:ComSpec -ArgumentList '/c start https://example.invalid'"],
    ],
    [
      'powershell.exe',
      ['-Command', "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('U3RhcnQtUHJvY2VzcyBjaHJvbWUuZXhl')) | iex"],
    ],
    ['node.exe', ['-e', "require('node:child_process').spawn('ch' + 'rome.exe')"]],
    [
      'node.exe',
      ['-e', "require('node:' + 'child_' + 'process')['sp' + 'awn']('ch' + 'rome.exe')"],
    ],
    [
      'powershell.exe',
      ['-Command', "& ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('Y2hyb21lLmV4ZQ==')))"],
    ],
    ['node.exe', ['-e', "require(['child_', 'process'].join('')).spawn(['chr', 'ome.exe'].join(''))"]],
    ['node.exe', ['-e', "const cp=require('node:child_process');cp['ex'+'ec']('chrome.exe')"]],
    ['node.exe', ['-p', "require('node:child_process').spawn('chrome.exe')"]],
    ['python.exe', ['-c', "__import__('sub'+'process').Popen('ch'+'rome.exe')"]],
    [
      'powershell.exe',
      ['-Command', '[Diagnostics.Process]::Start((-join ([char]99,[char]104,[char]114,[char]111,[char]109,[char]101,[char]46,[char]101,[char]120,[char]101)))'],
    ],
    [
      'python.exe',
      ['-c', "import ctypes; name=''.join(map(chr,[99,104,114,111,109,101,46,101,120,101])); ctypes.windll.shell32.ShellExecuteW(None,'open',name,None,None,1)"],
    ],
    ['node.exe', ['./uninspected-script.js']],
    ['custom-launcher.exe', ['--literal', 'fixture']],
    ['/tmp/curl', ['https://example.invalid/data']],
    ['curl', ['--config', '/tmp/untrusted-curlrc', 'https://example.invalid/data']],
    ['sh', ['-c', 'curl https://example.invalid/data']],
    ['env', ['curl', 'https://example.invalid/data']],
    ['env', ['node', '/tmp/payload.js']],
    ['sh', ['/tmp/launch-browser.sh']],
    ['env', ['python3', '/tmp/payload.py']],
    ['bash', ['/tmp/launch-browser.sh']],
    ['busybox', ['rm', '/tmp/fixture']],
    ['curl', ['http://example.invalid/data']],
    ['curl', ['--location', 'https://example.invalid/data']],
    ['powershell.exe', ['-Command', 'Write-Output payload > C:\\temp\\launch.url']],
    ['rundll32.exe', ['evil.dll,LaunchBrowser']],
    ['powershell.exe', ['-Command', 'Start-Process (Get-Item Env:ComSpec).Value']],
    [
      'powershell.exe',
      ['-Command', "'U3RhcnQtUHJvY2VzcyBjaHJvbWUuZXhl' | ForEach-Object { Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_))) }"],
    ],
    ['powershell.exe', ['-Command', 'Start-Process explorer.exe https://example.invalid']],
    ['rundll32.exe', ['shell32.dll,ShellExec_RunDLL', 'https://example.invalid']],
    ['cmd.exe', ['/c', 'start explorer.exe https://example.invalid']],
    ['cmd.exe', ['/c', 'echo fixture']],
    ['powershell.com', ['-Command', 'Write-Output "fixture"']],
    ['pwsh.exe', ['-Command', 'Write-Output "fixture"']],
    ['echo.exe', ['fixture']],
    ['printf.exe', ['%s', 'fixture']],
    ['open', ['/tmp/a.html']],
    ['xdg-open', ['/tmp/a.html']],
    ['open', ['/tmp/fixture.txt']],
    ['xdg-open', ['/tmp/fixture.txt']],
    ['gio', ['info', '/tmp/fixture.txt']],
    ['explorer.exe', ['C:\\fixture']],
    ['rundll32.exe', ['shell32.dll,Control_RunDLL']],
    ['C:\\work\\sibling.ps1', []],
  ])('applies the shared coordinator policy at service RPC: %s %j', async (
    executable,
    args,
  ) => {
    const execute = successfulRun();
    const { dispatcher, sendResult, sendError } = makeDispatcher(execute);

    await dispatcher.handleRpcRequest(request({ executable, args }));

    expect(execute).not.toHaveBeenCalled();
    expect(sendResult).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledWith(
      73, RPC_ERROR_CODES.INVALID_PARAMS, expect.stringMatching(/browser|shared Chrome/i),
    );
  });
});

function makeDispatcher(
  run: ReturnType<typeof successfulRun>,
  resolveTrustedExecutable = trustedFixtureExecutable,
) {
  const executor = policyExecutor([process.cwd()], run, resolveTrustedExecutable);
  const sendResult = vi.fn();
  const sendError = vi.fn();
  const dispatcher = new WorkerRpcDispatcher({
    config: { workingDirectories: [process.cwd()] },
    instanceManager: {},
    getFilesystemHandler: () => ({}),
    getSyncHandler: () => ({}),
    getTerminalHandler: () => ({}),
    applyConfigUpdate: vi.fn(),
    getCdpTunnel: () => ({}),
    stopManagedBrowser: vi.fn(),
    executeNodeCommand: (params: NodeExecParams): Promise<NodeExecResult> => executor.execute(params),
    sendResult,
    sendError,
  } as never);
  return { dispatcher, sendResult, sendError };
}

function request(params: unknown): RpcMessage {
  return {
    jsonrpc: '2.0',
    id: 73,
    method: 'node.exec',
    params,
    scope: 'service',
  };
}
