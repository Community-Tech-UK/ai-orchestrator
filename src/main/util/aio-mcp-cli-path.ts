/**
 * Resolves the path to the `aio-mcp` Node SEA dispatcher binary that ships
 * with every Harness install. The same binary is used for all four
 * stdio-MCP / native-host integrations (orchestrator-tools, codemem,
 * browser-gateway, Chrome native-messaging) — the dispatcher routes on its
 * first CLI argument.
 *
 * Resolution order (first existing path wins):
 *   1. `<resourcesPath>/aio-mcp-cli/aio-mcp[.exe]`         (packaged install)
 *   2. `dist/aio-mcp-cli-sea/aio-mcp[.exe]` beside this compiled file (local dev: SEA built)
 *   3. `dist/aio-mcp-cli-sea/aio-mcp[.exe]` under the working folder
 *
 * Candidate 2 exists because a dev app opened through the macOS launcher (the
 * test-Mac live-test copy, LT-1103) has `/` as its working folder, so candidate
 * 3 never finds a binary built inside the checkout.
 *
 * Returns `null` if neither exists — callers MUST handle that case and fall
 * back gracefully (e.g. by omitting the MCP server from the spawned CLI's
 * config). This mirrors the existing `resolveLoopControlCliPath` pattern.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';

export interface ResolveAioMcpCliPathOptions {
  resourcesPath?: string;
  cwd?: string;
  /** Folder of the compiled main-process files (`dist/main/util`); defaults to this file's own folder. */
  moduleDir?: string;
  platform?: NodeJS.Platform;
  exists?: (candidatePath: string) => boolean;
}

export function resolveAioMcpCliPath(options: ResolveAioMcpCliPathOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const suffix = platform === 'win32' ? '.exe' : '';
  const binaryName = `aio-mcp${suffix}`;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;

  const candidates: string[] = [];
  if (options.resourcesPath) {
    candidates.push(pathApi.join(options.resourcesPath, 'aio-mcp-cli', binaryName));
  } else if (typeof process.resourcesPath === 'string') {
    candidates.push(pathApi.join(process.resourcesPath, 'aio-mcp-cli', binaryName));
  }
  candidates.push(pathApi.resolve(options.moduleDir ?? __dirname, '..', '..', 'aio-mcp-cli-sea', binaryName));
  candidates.push(pathApi.resolve(options.cwd ?? process.cwd(), 'dist/aio-mcp-cli-sea', binaryName));

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}
