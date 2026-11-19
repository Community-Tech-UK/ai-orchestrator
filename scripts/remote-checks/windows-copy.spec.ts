import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const script = join(__dirname, 'windows-copy.js');
const { isPrivateAddress, relay, requirePort } = require('./windows-copy.js') as {
  isPrivateAddress(host: string): boolean; relay(...args: string[]): void; requirePort(value: string): number;
};

const temps: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'windows-copy-')));
  temps.push(dir);
  return dir;
};
const helper = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

describe('windows-copy relay safety', () => {
  it('joins loopback and private-network addresses only, never a wildcard or a public address', () => {
    for (const host of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.5']) expect(isPrivateAddress(host)).toBe(true);
    for (const host of ['0.0.0.0', '::', '::1', '8.8.8.8', '172.32.0.1', 'localhost', '']) expect(isPrivateAddress(host)).toBe(false);
    expect(() => relay('0.0.0.0', '9600', '127.0.0.1', '9600')).toThrow(/never a wildcard/);
    expect(() => relay('127.0.0.1', '9600', '203.0.113.9', '9600')).toThrow(/never a wildcard/);
    expect(helper('relay', '0.0.0.0', '9600', '127.0.0.1', '9600').status).toBe(2);
  });

  it('takes a debugging port from 1024 to 65535 only', () => {
    expect(requirePort('9531')).toBe(9531);
    for (const bad of ['80', '70000', 'abc', '']) expect(() => requirePort(bad)).toThrow(/1024 to 65535/);
  });

  it('forwards one port to another', async () => {
    const target = createServer(socket => socket.end('from the copy'));
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    const targetPort = (target.address() as { port: number }).port;
    const free = createServer();
    await new Promise<void>(resolve => free.listen(0, '127.0.0.1', resolve));
    const listenPort = (free.address() as { port: number }).port;
    await new Promise<void>(resolve => free.close(() => resolve()));
    const child = spawn(process.execPath, [script, 'relay', '127.0.0.1', String(listenPort), '127.0.0.1', String(targetPort)], { stdio: 'ignore' });
    children.push(child);
    const answer = await new Promise<string>((resolve, reject) => {
      const attempt = (left: number) => {
        const socket = connect(listenPort, '127.0.0.1');
        let body = '';
        socket.setEncoding('utf8');
        socket.on('data', chunk => { body += chunk; });
        socket.on('end', () => resolve(body));
        socket.on('error', () => (left > 0 ? setTimeout(() => attempt(left - 1), 100) : reject(new Error('relay never listened'))));
      };
      attempt(50);
    });
    target.close();
    expect(answer).toBe('from the copy');
  });
});

describe('windows-copy live-test ownership', () => {
  it('refuses to start a copy whose data is outside the owned folder, launching nothing', () => {
    const copy = tempDir();
    mkdirSync(join(copy, 'repo', 'scripts', 'remote-checks'), { recursive: true });
    for (const name of ['live-test-copy.js']) {
      writeFileSync(join(copy, 'repo', 'scripts', 'remote-checks', name), readFileSync(join(__dirname, name)));
    }
    writeFileSync(join(copy, 'repo', 'scripts', 'localbuild.js'), readFileSync(join(__dirname, '..', 'localbuild.js')));
    const result = helper('start', copy, join(tempDir(), 'harness-data'), '9531', 'a'.repeat(40));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/aio-lt-/);
    expect(existsSync(join(copy, 'windows-copy.json'))).toBe(false);
    expect(existsSync(join(copy, 'livetest-owner.json'))).toBe(false);
  });

  it('is not ready on an open window alone: Harness must have reported itself as the owned copy', async () => {
    const copy = tempDir();
    mkdirSync(join(copy, 'repo', 'scripts', 'remote-checks'), { recursive: true });
    writeFileSync(join(copy, 'repo', 'scripts', 'remote-checks', 'live-test-copy.js'), readFileSync(join(__dirname, 'live-test-copy.js')));
    writeFileSync(join(copy, 'repo', 'scripts', 'localbuild.js'), readFileSync(join(__dirname, '..', 'localbuild.js')));
    const server = createServer(socket => {
      socket.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n[{"type": "page"}]');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = String((server.address() as { port: number }).port);
    const asked = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [script, 'ready', port, copy], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', status => resolve({ status, stderr }));
    });
    server.close();
    expect(asked.status).toBe(1);
    expect(asked.stderr).toMatch(/not reported itself ready as the owned copy/);
  });
});

describe('windows-copy stop, pids and remove', () => {
  it('says nothing and stops nothing for a folder with no record', () => {
    const copy = tempDir();
    expect(helper('pids', copy)).toMatchObject({ status: 0, stdout: '' });
    expect(helper('stop', copy).status).toBe(0);
  });

  it('reports the recorded Harness process only while it is running', () => {
    const copy = tempDir();
    writeFileSync(join(copy, 'windows-copy.json'), JSON.stringify({ electron: process.pid }));
    expect(helper('pids', copy).stdout).toBe(`${process.pid}\n`);
    writeFileSync(join(copy, 'windows-copy.json'), JSON.stringify({ electron: 2_000_000_000 }));
    expect(helper('pids', copy).stdout).toBe('');
  });

  it('never stops a recorded process whose command line does not name this copy', async () => {
    const copy = tempDir();
    const stranger = spawn('sleep', ['30'], { stdio: 'ignore' });
    children.push(stranger);
    writeFileSync(join(copy, 'windows-copy.json'), JSON.stringify({ electron: stranger.pid, server: stranger.pid, relay: stranger.pid }));
    expect(helper('stop', copy).status).toBe(0);
    expect(stranger.exitCode).toBeNull();
    expect(() => process.kill(stranger.pid!, 0)).not.toThrow();
  });

  it('unlinks the shared packages before deleting a copy, leaving the install they point to', () => {
    const base = tempDir();
    const install = join(base, 'install', 'node_modules');
    const copy = join(base, 'copy');
    mkdirSync(install, { recursive: true });
    writeFileSync(join(install, 'kept.txt'), 'shared');
    mkdirSync(join(copy, 'repo'), { recursive: true });
    writeFileSync(join(copy, 'repo', 'own.txt'), 'own');
    symlinkSync(install, join(copy, 'repo', 'node_modules'), 'junction');
    expect(helper('remove', copy).status).toBe(0);
    expect(existsSync(copy)).toBe(false);
    expect(readFileSync(join(install, 'kept.txt'), 'utf8')).toBe('shared');
  });

  it('refuses a command it does not know', () => {
    expect(helper('format-disk')).toMatchObject({ status: 2 });
  });
});
