import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const requireNodeModule = createRequire(import.meta.url);

async function runFetcherFixture(arch: string) {
  const output = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const processFixture = { platform: 'win32', arch, env: { FETCH_RTK_SKIP: '0' },
    argv: ['node', 'fetch-rtk-binaries.js', '--current-platform'], exit: vi.fn(), exitCode: undefined };
  const files = { mkdirSync: vi.fn(), existsSync: () => true,
    readFileSync: (path: string) => path.endsWith('.json')
      ? JSON.stringify({ version: '0.52.0', hashes: { 'win32-x64': 'CHECKSUM_PLACEHOLDER' } })
      : path.endsWith('LICENSE') ? 'Apache License Version 2.0' : Buffer.from('mismatched binary fixture'),
    mkdtempSync: () => '/fixture-only-fetch-directory', rmSync: vi.fn(), writeFileSync: vi.fn() };
  const get = vi.fn(() => {
    const request = new EventEmitter();
    queueMicrotask(() => request.emit('error', new Error('fixture download refused')));
    return request;
  });
  await runInNewContext(readFileSync('scripts/fetch-rtk-binaries.js', 'utf8'), {
    __dirname: join(process.cwd(), 'scripts'), console: output, process: processFixture,
    require: (name: string) => name === 'node:fs' ? files : name === 'node:https' ? { get } : requireNodeModule(name),
  });
  return { output, processFixture, get };
}

describe('worker RTK install', () => {
  it('allows a worker build without RTK on a platform with no pinned binary', async () => {
    const { output, processFixture, get } = await runFetcherFixture('arm64');
    expect(processFixture.exit).not.toHaveBeenCalled();
    expect(processFixture.exitCode).toBeUndefined();
    expect(output.warn).toHaveBeenCalledWith(expect.stringContaining('win32-arm64'));
    expect(get).not.toHaveBeenCalled();
  });
  it('still refuses a supported platform whose cached checksum mismatches and download fails', async () => {
    const { output, processFixture, get } = await runFetcherFixture('x64');
    expect(processFixture.exit).toHaveBeenCalledWith(1);
    expect(get, JSON.stringify(output.error.mock.calls.map(call => call.map(String)))).toHaveBeenCalledTimes(1);
    expect(output.warn).toHaveBeenCalledWith(expect.stringContaining('sha256 mismatch'));
  });
  it('verifies and installs just the current platform through the pinned fetcher', () => {
    const scratch = mkdtempSync(join(process.cwd(), '_scratch/oct-remote-spawn-install-'));
    try {
      mkdirSync(join(scratch, 'scripts/licenses'), { recursive: true });
      writeFileSync(join(scratch, 'scripts/fetch-rtk-binaries.js'), readFileSync('scripts/fetch-rtk-binaries.js'));
      writeFileSync(join(scratch, 'scripts/licenses/rtk-0.52.0-LICENSE'), readFileSync('scripts/licenses/rtk-0.52.0-LICENSE'));
      const manifest = JSON.parse(readFileSync('scripts/rtk-binaries.sha256.json', 'utf8'));
      const binary = 'obvious worker RTK fixture';
      for (const platform of Object.keys(manifest.hashes)) {
        manifest.hashes[platform] = createHash('sha256').update(binary).digest('hex');
        const directory = join(scratch, 'resources/rtk', platform);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, platform.startsWith('win32') ? 'rtk.exe' : 'rtk'), binary);
      }
      writeFileSync(join(scratch, 'scripts/rtk-binaries.sha256.json'), JSON.stringify(manifest));
      const result = spawnSync(process.execPath, [join(scratch, 'scripts/fetch-rtk-binaries.js'), '--current-platform'], {
        encoding: 'utf8', env: { ...process.env, FETCH_RTK_SKIP: '0' }, timeout: 5_000,
      });
      expect(result.status, result.stderr).toBe(0);
      for (const platform of Object.keys(manifest.hashes)) {
        expect(existsSync(join(scratch, 'resources/rtk', platform, 'LICENSE')), platform)
          .toBe(platform === `${process.platform}-${process.arch}`);
      }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});
