import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { discoverCodexDeviceLoginExecutable, probeCodexDeviceLoginIdentity } from './codex-device-login-native';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const roots: string[] = [];
// Discovery returns real paths, and the macOS temp folder sits behind a symlink (/var to /private/var).
function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-native-')));
  roots.push(root);
  return root;
}
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.resetAllMocks(); vi.useRealTimers(); });

describe('native Codex discovery', () => {
  it('finds a native binary without executing a PATH shim and refuses script headers', () => {
    const root = tempRoot();
    const path = join(root, process.platform === 'win32' ? 'codex.exe' : 'codex');
    writeFileSync(path, '#!/bin/sh\nDO_NOT_RUN', { mode: 0o700 });
    expect(() => discoverCodexDeviceLoginExecutable([path])).toThrow('native_executable_unavailable');
    const magic = process.platform === 'win32' ? Buffer.from([0x4d, 0x5a, 0, 0])
      : process.platform === 'darwin' ? Buffer.from([0xcf, 0xfa, 0xed, 0xfe]) : Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
    writeFileSync(path, magic, { mode: 0o700 });
    expect(discoverCodexDeviceLoginExecutable([path])).toBe(path);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('resolves the npm platform vendor binary without running its JavaScript launcher', () => {
    const root = tempRoot();
    const launcher = join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    mkdirSync(join(launcher, '..'), { recursive: true });
    writeFileSync(launcher, 'DO_NOT_RUN');
    const triplet = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : process.platform === 'win32' ? 'pc-windows-msvc' : 'unknown-linux-musl'}`;
    const binary = join(root, 'node_modules', '@openai', `codex-${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`, 'vendor', triplet, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
    mkdirSync(join(binary, '..'), { recursive: true });
    writeFileSync(binary, process.platform === 'win32' ? Buffer.from([0x4d, 0x5a, 0, 0]) : process.platform === 'darwin' ? Buffer.from([0xcf, 0xfa, 0xed, 0xfe]) : Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o700 });
    expect(discoverCodexDeviceLoginExecutable([launcher])).toBe(binary);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('bounded native identity probe', () => {
  function child() {
    const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    return proc;
  }
  it('uses direct pinned native pipes and account/read without refresh, returns only exact email', async () => {
    const proc = child();
    const messages: Record<string, unknown>[] = [];
    proc.stdin.on('data', chunk => messages.push(JSON.parse(chunk.toString())));
    const result = probeCodexDeviceLoginIdentity('/native/codex', '/owned/home', new AbortController().signal);
    proc.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
    proc.stdout.write(JSON.stringify({ id: 2, result: { account: { email: 'account@example.test' } } }) + '\n');
    await expect(result).resolves.toBe('account@example.test');
    expect(messages).toContainEqual(expect.objectContaining({ method: 'account/read', params: { refreshToken: false } }));
    expect(spawn).toHaveBeenCalledWith('/native/codex', ['-c', 'cli_auth_credentials_store=file', 'app-server'], expect.objectContaining({ shell: false, stdio: ['pipe', 'pipe', 'pipe'] }));
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });
  it.each(['abort', 'timeout', 'overflow', 'malformed', 'exit'])('stops private probe on %s without raw diagnostics', async kind => {
    vi.useFakeTimers();
    const proc = child();
    const abort = new AbortController();
    const result = probeCodexDeviceLoginIdentity('/native/codex', '/owned/home', abort.signal);
    const assertion = expect(result).rejects.toThrow(/^identity_probe_failed$/);
    if (kind === 'abort') abort.abort();
    if (kind === 'timeout') await vi.advanceTimersByTimeAsync(10_001);
    if (kind === 'overflow') proc.stderr.write('PRIVATE_PLACEHOLDER'.repeat(5000));
    if (kind === 'malformed') proc.stdout.write('PRIVATE_PLACEHOLDER\n');
    if (kind === 'exit') proc.emit('close', 1);
    await assertion;
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
