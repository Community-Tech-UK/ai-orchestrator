/**
 * No agent can reach the Linear call. Agents get at the app through MCP tools, the `aio-mcp` command and the session
 * RPC, all of which live under `src/main/mcp/`, plus the Plan Queue's own tool operations. This guard fails if any
 * file outside the Linear folder imports the Linear call modules. A later step that wires the Linear code into
 * the app (never into those routes) adds its file to the list below on purpose.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..', '..');
const LINEAR_FOLDER = join('src', 'main', 'plan-queue', 'linear') + sep;
/**
 * Files outside the Linear folder that may import it, each on purpose:
 * - the operator's IPC handlers for the Plan Queue page: they answer the page, never an agent;
 * - the Linear work source (`plan-queue-linear-source.ts`): the queue's own code, run by the app for a Linear run. It
 *   is reached only through `plan-queue-work-sources.ts`, which imports the source file and not the Linear folder, and
 *   nothing under `src/main/mcp/` names it (the second test below), so no tool, command or RPC method can call it.
 */
const ALLOWED_IMPORTERS: readonly string[] = [
  join('src', 'main', 'ipc', 'handlers', 'plan-queue-linear-handlers.ts'),
  join('src', 'main', 'plan-queue', 'plan-queue-linear-source.ts'),
];
const IMPORT = /from\s+['"][^'"]*\/linear\/[^'"]*['"]|from\s+['"]\.\/linear\/|linear-call['"]|linear-connector-address['"]/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (entry === 'node_modules' || entry === 'dist') return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(path) ? [path] : [];
  });
}

describe('the Linear call is not reachable by agents', () => {
  it('is imported by nothing outside its own folder', () => {
    const importers = ['src/main', 'src/preload', 'src/shared', 'packages']
      .flatMap((folder) => sourceFiles(join(ROOT, folder)))
      .map((path) => relative(ROOT, path))
      .filter((path) => !path.startsWith(LINEAR_FOLDER))
      .filter((path) => IMPORT.test(readFileSync(join(ROOT, path), 'utf8')))
      .filter((path) => !ALLOWED_IMPORTERS.includes(path));
    expect(importers).toEqual([]);
  });

  it('registers no tool, command or RPC method named for it', () => {
    const agentRoutes = sourceFiles(join(ROOT, 'src/main/mcp'))
      .map((path) => relative(ROOT, path))
      .filter((path) => /linear/i.test(readFileSync(join(ROOT, path), 'utf8')));
    expect(agentRoutes).toEqual([]);
  });
});
