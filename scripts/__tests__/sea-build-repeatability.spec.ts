import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const tsxCli = resolve(repoRoot, 'node_modules/tsx/dist/cli.cjs');
const scratchDirectories: string[] = [];

interface SeaBuildCase {
  name: string;
  script: string;
  bundleDirectory: string;
  outputDirectory: string;
  executable: string;
}

const seaBuildCases: SeaBuildCase[] = [
  {
    name: 'AIO MCP',
    script: 'build-aio-mcp-cli-sea.ts',
    bundleDirectory: 'aio-mcp-cli',
    outputDirectory: 'aio-mcp-cli-sea',
    executable: 'aio-mcp',
  },
  {
    name: 'loop control',
    script: 'build-loop-control-cli-sea.ts',
    bundleDirectory: 'loop-control-cli',
    outputDirectory: 'loop-control-cli-sea',
    executable: 'aio-loop-control',
  },
];

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32')('SEA build repeatability', () => {
  it.each(seaBuildCases)(
    'replaces a read-only previous $name executable',
    ({ script, bundleDirectory, outputDirectory, executable }) => {
      const scratchDirectory = mkdtempSync(join(tmpdir(), 'aio-sea-repeatability-'));
      scratchDirectories.push(scratchDirectory);

      const bundlePath = join(scratchDirectory, 'dist', bundleDirectory, 'index.js');
      const executablePath = join(scratchDirectory, 'dist', outputDirectory, executable);
      mkdirSync(join(scratchDirectory, 'dist', bundleDirectory), { recursive: true });
      mkdirSync(join(scratchDirectory, 'dist', outputDirectory), { recursive: true });
      writeFileSync(bundlePath, "console.log('SEA repeatability fixture');\n");
      writeFileSync(executablePath, 'stale executable');
      chmodSync(executablePath, 0o555);

      const buildResult = spawnSync(
        process.execPath,
        [tsxCli, resolve(repoRoot, script)],
        {
          cwd: scratchDirectory,
          encoding: 'utf8',
          timeout: 60_000,
        },
      );

      expect(
        buildResult.status,
        `${buildResult.stdout}\n${buildResult.stderr}`,
      ).toBe(0);
      expect(statSync(executablePath).mode & 0o777).toBe(0o755);

      const runResult = spawnSync(executablePath, [], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(runResult.status, runResult.stderr).toBe(0);
      expect(runResult.stdout).toContain('SEA repeatability fixture');
    },
    90_000,
  );
});
