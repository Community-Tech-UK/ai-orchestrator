import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUpdateConnectionCommand } from './update-connection-cli';
import { acquireSingleInstanceLock, isSingleInstanceLockHeld } from '../single-instance-lock';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

describe('update-connection', () => {
  const nativePlatform = process.platform;
  let directory: string;
  let configPath: string;
  let saved: Record<string, unknown>;
  const stdout = vi.fn();
  const stderr = vi.fn();
  const target = 'wss://coordinator.example.invalid:4878';

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-connection-update-'));
    configPath = path.join(directory, 'worker-node.json');
    saved = {
      nodeId: randomUUID(), namespace: 'test', name: 'Test worker',
      coordinatorUrl: 'ws://coordinator.example.invalid:4878',
      coordinatorUrls: ['ws://192.0.2.1:4878'],
      advertisedCoordinatorUrls: ['ws://192.0.2.2:4878'],
      authToken: 'placeholder-auth', nodeToken: 'placeholder-node', recoveryToken: 'placeholder-recovery',
      extensionRelay: { enabled: true, extensionToken: 'placeholder-extension', socketPath: 'unchanged' },
      browserAutomation: { enabled: true, profileDir: 'unchanged-profile' },
      futureAccountData: { preserve: ['unchanged', '保留 café'] },
    };
    fs.writeFileSync(configPath, JSON.stringify(saved), { mode: 0o600 });
    vi.clearAllMocks();
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: nativePlatform });
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const run = (args?: string[]) => runUpdateConnectionCommand(
    args ?? ['--config', configPath, '--coordinator', target], { stdout, stderr },
  );

  it('changes only connection fields and keeps restrictive permissions', () => {
    expect(run()).toBe(0);
    const expected: Record<string, unknown> = { ...saved, coordinatorUrl: target };
    delete expected['coordinatorUrls'];
    delete expected['advertisedCoordinatorUrls'];
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(expected);
    if (process.platform !== 'win32') expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory)).toEqual(['worker-node.json']);
    expect(stdout.mock.calls.flat().join('')).not.toContain('placeholder');
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each(['ws://host', 'https://host', 'wss://user:placeholder@host', 'wss://host?token=placeholder', 'wss://host#placeholder', 'not-a-url'])('refuses unsafe address %s without modifying the config', (url) => {
    const before = fs.readFileSync(configPath);
    expect(run(['--config', configPath, '--coordinator', url])).toBe(1);
    expect(fs.readFileSync(configPath)).toEqual(before);
    expect(stderr.mock.calls.flat().join('')).not.toContain('placeholder');
  });

  it.each([[], ['--coordinator', target], ['--config'], ['--config', 'unused', '--unknown', 'placeholder']].map((args) => ({ args })))('requires explicit complete arguments: $args', ({ args }) => {
    expect(run(args)).toBe(1);
    expect(stderr.mock.calls.flat().join('')).not.toContain('placeholder');
  });

  it.each(['null', '[]', '{"authToken":"placeholder"', '{}'])('refuses malformed or unpaired config without revealing its contents: %s', (raw) => {
    fs.writeFileSync(configPath, raw);
    expect(run()).toBe(1);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(raw);
    expect(stderr.mock.calls.flat().join('')).not.toContain('placeholder');
  });

  it.skipIf(process.platform !== 'darwin').each(['source', 'directory'])('refuses macOS %s ACLs without changing bytes or access rules', (location) => {
    fs.chmodSync(configPath, 0o644);
    const aclPath = location === 'source' ? configPath : directory;
    const rule = location === 'source' ? 'user:nobody deny read' : 'user:nobody allow read,file_inherit,only_inherit';
    execFileSync('/bin/chmod', ['+a', rule, aclPath]);
    if (location === 'directory') {
      const probe = path.join(directory, 'empty-inheritance-probe');
      fs.writeFileSync(probe, '', { mode: 0o600 });
      expect(execFileSync('/bin/ls', ['-lde', probe], { encoding: 'utf8' })).toContain('inherited');
      fs.unlinkSync(probe);
    }
    // -n keeps the rule's raw ID: the name lookup (nobody vs a GUID) varies under load.
    const aclBefore = execFileSync('/bin/ls', ['-lden', aclPath], { encoding: 'utf8' });
    expect(aclBefore).toContain('0:');
    const before = fs.readFileSync(configPath);
    try {
      expect(run()).toBe(1);
      expect(fs.readFileSync(configPath)).toEqual(before);
      expect(execFileSync('/bin/ls', ['-lden', aclPath], { encoding: 'utf8' })).toBe(aclBefore);
      expect(fs.readdirSync(directory)).toEqual(['worker-node.json']);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      execFileSync('/bin/chmod', ['-N', aclPath]);
    }
  });

  it.each(['named', 'default', 'missing-tool'])('refuses Linux %s ACL inspection without modifying the config', (kind) => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      if (kind === 'missing-tool') throw Object.assign(new Error('getfacl unavailable'), { code: 'ENOENT' });
      return 'user::rw-\ngroup::---\nother::---\n' + (kind === 'named' ? 'user:nobody:r--\nmask::r--\n' : 'default:user::rwx\n');
    });
    expect(run()).toBe(1);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(saved);
    expect(fs.readdirSync(directory)).toEqual(['worker-node.json']);
    expect(stdout).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'nonzero'])('cleans Windows helper %s failure and releases the identity lock', (failure) => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.mocked(execFileSync).mockImplementationOnce((_file, _args, options) => {
      const opts = options as import('node:child_process').ExecFileSyncOptions;
      fs.writeFileSync(opts.env!['AIO_CONNECTION_TEMP']!, 'placeholder-partial', { mode: 0o600 });
      throw Object.assign(new Error('placeholder-sensitive-error'), failure === 'timeout' ? { code: 'ETIMEDOUT' } : { status: 1 });
    });
    expect(run()).toBe(1);
    expect(fs.readdirSync(directory)).toEqual(['worker-node.json']);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(saved);
    expect(isSingleInstanceLockHeld({ key: `${saved['namespace']}:${saved['nodeId']}` })).toBe(false);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join('')).not.toContain('placeholder');
    expect(execFileSync).toHaveBeenCalledWith('powershell.exe', expect.any(Array), expect.objectContaining({ timeout: 15_000, killSignal: 'SIGKILL' }));
  });

  it('refuses missing config without creating one', () => {
    fs.rmSync(configPath);
    expect(run()).toBe(1);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('accepts the Windows UTF-8 BOM without changing other values', () => {
    fs.writeFileSync(configPath, '\uFEFF' + JSON.stringify(saved));
    expect(run()).toBe(0);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).futureAccountData).toEqual(saved['futureAccountData']);
  });

  it('refuses multiply-linked config files', () => {
    fs.linkSync(configPath, path.join(directory, 'linked.json'));
    expect(run()).toBe(1);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(saved);
  });

  it('refuses legacy transport aliases which override the primary on startup', () => {
    fs.writeFileSync(configPath, JSON.stringify({ ...saved, host: 'old.invalid', port: 4878 }));
    const before = fs.readFileSync(configPath);
    expect(run()).toBe(1);
    expect(fs.readFileSync(configPath)).toEqual(before);
  });

  it('refuses a running worker and leaves its lock intact', () => {
    const lock = acquireSingleInstanceLock({ key: `${saved['namespace']}:${saved['nodeId']}` });
    try {
      expect(run()).toBe(1);
      expect(fs.existsSync(lock!.path)).toBe(true);
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(saved);
    } finally { lock?.release(); }
  });

  it.skipIf(process.platform === 'win32')('refuses symlinks', () => {
    const original = path.join(directory, 'original.json');
    fs.renameSync(configPath, original);
    fs.symlinkSync(original, configPath);
    expect(run()).toBe(1);
    expect(JSON.parse(fs.readFileSync(original, 'utf8'))).toEqual(saved);
  });

  it.skipIf(process.platform === 'win32')('leaves the original intact and removes its temporary file if replacement fails', () => {
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('placeholder-sensitive-error'); });
    expect(run()).toBe(1);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(saved);
    expect(fs.readdirSync(directory)).toEqual(['worker-node.json']);
    expect(stderr.mock.calls.flat().join('')).not.toContain('placeholder');
  });
});
