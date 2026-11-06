/**
 * Finds the Claude transcript files that can hold requests from the last 7 days.
 *
 * Claude Code keeps one folder per workspace under `<config home>/projects/`.
 * Inside it, a session is `<session id>.jsonl`; helper agents are either
 * `agent-*.jsonl` beside it or `<session id>/subagents/*.jsonl`. Harness sessions
 * on a signed-in account use that account's own config home (`claude-cli-profiles`),
 * so every home has to be searched, not only `~/.claude`.
 *
 * Everything here is read-only and bounded: only directory listings and `stat`.
 */

import { promises as fs, readdirSync, realpathSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export interface TranscriptFile {
  path: string;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  ino: number;
  /** Session id taken from the file or folder name. Lines carry their own and win. */
  fileSessionId: string;
}

export interface ClaudeRootDeps {
  home?: string;
  /** Harness's data folder, where account profile homes live. */
  stateRoot?: string;
  profilesDirName?: string;
  env?: NodeJS.ProcessEnv;
}

/** Every Claude config home on this machine: the default one, each account profile, and CLAUDE_CONFIG_DIR. */
export function resolveClaudeConfigRoots(deps: ClaudeRootDeps = {}): string[] {
  const candidates = [join(deps.home ?? homedir(), '.claude')];
  const fromEnv = (deps.env ?? process.env)['CLAUDE_CONFIG_DIR']?.trim();
  if (fromEnv) candidates.push(fromEnv);
  if (deps.stateRoot) {
    const profiles = join(deps.stateRoot, deps.profilesDirName ?? 'claude-cli-profiles');
    try {
      for (const entry of readdirSync(profiles, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(join(profiles, entry.name));
      }
    } catch (error) {
      // A missing home is normal; a failed read must not look like zero usage.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const candidate of candidates) {
    let key = candidate;
    try {
      key = realpathSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(key);
  }
  return roots;
}

async function listDirectory(path: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  }
}

const STAT_BATCH = 32;

/** Transcript files modified at or after `modifiedSince`, newest first. */
export async function discoverTranscriptFiles(
  roots: readonly string[],
  modifiedSince: number,
): Promise<TranscriptFile[]> {
  const paths: { path: string; fileSessionId: string }[] = [];
  for (const root of roots) {
    const projectsDir = join(root, 'projects');
    for (const project of await listDirectory(projectsDir)) {
      if (!project.isDirectory()) continue;
      const projectDir = join(projectsDir, project.name);
      for (const entry of await listDirectory(projectDir)) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          paths.push({ path: join(projectDir, entry.name), fileSessionId: basename(entry.name, '.jsonl') });
        } else if (entry.isDirectory()) {
          const helperDir = join(projectDir, entry.name, 'subagents');
          for (const helper of await listDirectory(helperDir)) {
            if (helper.isFile() && helper.name.endsWith('.jsonl')) {
              paths.push({ path: join(helperDir, helper.name), fileSessionId: entry.name });
            }
          }
        }
      }
    }
  }

  const files: TranscriptFile[] = [];
  for (let index = 0; index < paths.length; index += STAT_BATCH) {
    const batch = paths.slice(index, index + STAT_BATCH);
    const stats = await Promise.all(batch.map(async (item) => {
      try {
        return { item, stat: await fs.stat(item.path) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return null;
      }
    }));
    for (const result of stats) {
      if (!result || result.stat.mtimeMs < modifiedSince) continue;
      files.push({
        path: result.item.path,
        size: result.stat.size,
        mtimeMs: result.stat.mtimeMs,
        birthtimeMs: result.stat.birthtimeMs || result.stat.mtimeMs,
        ino: result.stat.ino,
        fileSessionId: result.item.fileSessionId,
      });
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
