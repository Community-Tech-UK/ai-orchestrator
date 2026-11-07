import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertRunReady, type ReadinessShell } from './plan-queue-run-readiness';

/** Set to fake a nearly full disk; null reads the real one. */
const disk = vi.hoisted(() => ({ freeBlocks: null as number | null }));
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>();
  return { ...actual, statfs: (async (...args: Parameters<typeof actual.statfs>) => disk.freeBlocks === null
    ? actual.statfs(...args) : { bavail: disk.freeBlocks, bsize: 1024 ** 2 }) as typeof actual.statfs };
});

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plan-queue-ready-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A shell that answers by command text; anything unlisted succeeds. */
function shell(answers: Record<string, { exitCode: number; output: string }> = {}): ReadinessShell & { run: ReturnType<typeof vi.fn> } {
  return { run: vi.fn(async (command: string) => answers[command] ?? { exitCode: 0, output: '' }) };
}

describe('assertRunReady', () => {
  it('refuses when the disk is nearly full, saying how much is free', async () => {
    disk.freeBlocks = 1024;
    try { await expect(assertRunReady(root, [], shell())).rejects.toThrow(/only 1\.1 GB is free right now/); }
    finally { disk.freeBlocks = null; }
  });

  it('passes a project with no pins, no lockfile and no gates without running anything', async () => {
    const sh = shell();
    await expect(assertRunReady(root, [], sh)).resolves.toBeUndefined();
    expect(sh.run).not.toHaveBeenCalled();
  });

  it('refuses when the Node the checks would use differs in major version from .nvmrc, and names both', async () => {
    writeFileSync(join(root, '.nvmrc'), 'v24.22.1\n');
    await expect(assertRunReady(root, [], shell({ 'node --version': { exitCode: 0, output: 'v26.1.0\n' } })))
      .rejects.toThrow(/Node v26\.1\.0.*asks for Node v24\.22\.1 \(its \.nvmrc file\).*Install Node v24\.22\.1 with nvm/);
    await expect(assertRunReady(root, [], shell({ 'node --version': { exitCode: 0, output: 'v24.9.0\n' } }))).resolves.toBeUndefined();
  });

  it('refuses when Node cannot be started at all', async () => {
    writeFileSync(join(root, '.nvmrc'), '24\n');
    await expect(assertRunReady(root, [], shell({ 'node --version': { exitCode: 127, output: 'node: not found' } })))
      .rejects.toThrow(/Node could not be started/);
  });

  it('never runs the dry run of npm ci on an npm that predates --dry-run support, which would empty node_modules', async () => {
    writeFileSync(join(root, 'package-lock.json'), '{}');
    for (const version of ['8.19.4\n', '10.5.0\n', '10.7.9\n', 'not a version\n']) {
      const sh = shell({ 'npm --version': { exitCode: 0, output: version }, 'npm ci --dry-run --ignore-scripts --no-audit --no-fund': { exitCode: 1, output: 'must not run' } });
      await expect(assertRunReady(root, [], sh), version).resolves.toBeUndefined();
      expect(sh.run.mock.calls.map((call) => call[0])).not.toContain('npm ci --dry-run --ignore-scripts --no-audit --no-fund');
    }
    const failedVersion = shell({ 'npm --version': { exitCode: 1, output: 'npm: not found' } });
    await expect(assertRunReady(root, [], failedVersion)).resolves.toBeUndefined();
  });

  it('refuses when the dry run of npm ci fails, but only for a project with a lockfile', async () => {
    const failing = { 'npm --version': { exitCode: 0, output: '10.9.2\n' }, 'npm ci --dry-run --ignore-scripts --no-audit --no-fund': { exitCode: 1, output: 'lockfile out of date' } };
    await expect(assertRunReady(root, [], shell(failing))).resolves.toBeUndefined();
    writeFileSync(join(root, 'package-lock.json'), '{}');
    await expect(assertRunReady(root, [], shell(failing))).rejects.toThrow(/would not install cleanly from its lock file.*lockfile out of date/);
  });

  it('refuses a check that names a missing npm script, and says what to do', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { lint: 'true' } }));
    await expect(assertRunReady(root, ['npm run lint'], shell())).resolves.toBeUndefined();
    await expect(assertRunReady(root, ['npm run lint', 'npm run typecheck:spec'], shell()))
      .rejects.toThrow(/"npm run typecheck:spec" cannot run.*no "typecheck:spec" command.*leave them empty/);
    await expect(assertRunReady(root, ['npm run lint'], shell())).resolves.toBeUndefined();
  });

  it('refuses a check whose program is not on the PATH, and ignores command text it cannot judge', async () => {
    if (process.platform !== 'win32') {
      await expect(assertRunReady(root, ['make check'], shell({ 'command -v make': { exitCode: 1, output: '' } })))
        .rejects.toThrow(/"make" is not installed where Harness looks for programs/);
    }
    await expect(assertRunReady(root, ['make check'], shell())).resolves.toBeUndefined();
    const sh = shell();
    // Flags before the script name (npm run -w pkg test) cannot be judged by the first word, so they are left alone.
    await expect(assertRunReady(root, ['$(whoami) && true', 'FOO=1 run', 'npm run --silent lint', 'npm run -w pkg test'], sh)).resolves.toBeUndefined();
    expect(sh.run).not.toHaveBeenCalled();
  });
});
