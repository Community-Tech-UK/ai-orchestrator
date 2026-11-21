import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTOML } from 'toml-eslint-parser';
import { harnessLiveTestDataPath } from '../../../app/live-test-context';
import { getLogger } from '../../../logging/logger';
import { mergeCodexMcpConfig } from './codex-mcp-config-merge';

const logger = getLogger('CodexLiveTestOverlay');

/** File name inside a live-test copy's own data folder. Removed with that folder. */
export const CODEX_LIVE_TEST_OVERLAY_FILE = 'codex-config-overlay.toml';
const MAX_OVERLAY_BYTES = 16 * 1024;

/**
 * Tool-server definitions only: anything else could change auth, sandbox or approval settings.
 * Returns the server names, for the log.
 */
function toolServerNames(overlay: string): string[] {
  const names = new Set<string>();
  for (const entry of parseTOML(overlay, { tomlVersion: '1.1' }).body[0].body) {
    // Only a standard `[mcp_servers.<name>]` table: not a root key (`mcp_servers.x.command = ...`),
    // an array table, or a sub-table such as `[mcp_servers.x.y]`.
    const path = entry.type === 'TOMLTable'
      ? entry.resolvedKey
      : entry.key.keys.map((part) => (part.type === 'TOMLBare' ? part.name : part.value));
    const server = path[1];
    if (entry.type !== 'TOMLTable' || entry.kind !== 'standard' || path.length !== 2 || path[0] !== 'mcp_servers' || typeof server !== 'string') {
      throw new Error(`The Codex live-test overlay may only define [mcp_servers.<name>] tables (found "${path.map(String).join('.')}")`);
    }
    names.add(server);
  }
  return [...names];
}

/**
 * The live-test copy's Codex tool-server overlay, or null. Applies only inside a validated live-test
 * copy (never a normal or packaged production run) and only from a plain file in that copy's own data
 * folder, so a test can add a broken tool server without touching `~/.codex` or copying a sign-in.
 * An unusable file throws: a test that asked for an overlay must not silently run without it.
 */
export function readCodexLiveTestOverlay(): string | null {
  const dataPath = harnessLiveTestDataPath();
  if (!dataPath) return null;
  const file = join(dataPath, CODEX_LIVE_TEST_OVERLAY_FILE);
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The Codex live-test overlay must be a regular file');
  if (stat.size > MAX_OVERLAY_BYTES) throw new Error('The Codex live-test overlay is too large');
  if ((stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('The Codex live-test overlay must belong to the current user and not be writable by others');
  }
  const overlay = readFileSync(file, 'utf8');
  // Server names only in the log, never the definitions (they may carry arguments or environment values).
  logger.info('Applying the Codex live-test tool-server overlay', { servers: toolServerNames(overlay) });
  return overlay;
}

/** Overlay servers replace same-named user servers; everything else in the config is kept. */
export function applyCodexLiveTestOverlay(config: string, overlay: string | null): string {
  return overlay ? mergeCodexMcpConfig(config, overlay, false) : config;
}
