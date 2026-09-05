/**
 * Locating the `aio-loop-control` binary (or its dev shim) for a loop's control
 * directory.
 *
 * Split out of `loop-control.ts` to keep that file inside its size ceiling.
 * Behaviour is unchanged.
 */

import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export async function resolveLoopControlCliPath(controlDir: string): Promise<string> {
  const binaryName = process.platform === 'win32' ? 'aio-loop-control.exe' : 'aio-loop-control';
  const resourcePath = typeof process.resourcesPath === 'string'
    ? path.join(process.resourcesPath, 'loop-control-cli', binaryName)
    : '';
  const candidates = [
    resourcePath,
    path.resolve('dist/loop-control-cli-sea', binaryName),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) return candidate;
  }

  const shimPath = path.join(controlDir, process.platform === 'win32' ? 'aio-loop-control.cmd' : 'aio-loop-control');
  const scriptCandidates = [
    path.resolve('dist/loop-control-cli/index.js'),
    path.resolve('dist/main/orchestration/loop-control-cli.js'),
  ];
  const scriptPath = scriptCandidates.find((candidate) => fsSync.existsSync(candidate)) ?? scriptCandidates[0];
  if (process.platform === 'win32') {
    await fs.writeFile(shimPath, `@echo off\r\nnode "${scriptPath}" %*\r\n`, { mode: 0o700 });
  } else {
    await fs.writeFile(shimPath, `#!/usr/bin/env sh\nexec node "${scriptPath}" "$@"\n`, { mode: 0o700 });
  }
  return shimPath;
}
