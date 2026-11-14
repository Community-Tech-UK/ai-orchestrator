import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { git, gitText } from './queue-git';

/** Same file name and format as the Mac's job folders (plan-queue-worktree.ts), inside the folder's git dir. */
const PROVISIONED_PATHS_FILE = 'plan-queue-provisioned';

async function recordFile(folder: string): Promise<string> {
  return path.join(await gitText(['rev-parse', '--absolute-git-dir'], folder), PROVISIONED_PATHS_FILE);
}

/** The paths setup left in this folder (never the agent's work); null when nothing was ever recorded. */
export async function readProvisionedRecord(folder: string): Promise<string[] | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(await recordFile(folder), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : null;
  } catch {
    return null;
  }
}

export async function readProvisioned(folder: string): Promise<string[]> {
  return (await readProvisionedRecord(folder)) ?? [];
}

export async function writeProvisioned(folder: string, paths: readonly string[]): Promise<void> {
  await fs.writeFile(await recordFile(folder), JSON.stringify([...new Set(paths)]), 'utf8');
}

/** Untracked, not-ignored paths in the folder (directories listed whole), as `ls-files --others` shows them. */
export async function listUntracked(folder: string): Promise<string[]> {
  const listed = await git(['ls-files', '--others', '--exclude-standard', '--directory', '-z'], folder);
  return listed.split('\0').map(entry => entry.replace(/\/$/, '')).filter(Boolean);
}

/** The agent's work: everything except the provisioned paths (the idea of `workPathspec` on the Mac). */
export function workPathspec(provisioned: readonly string[]): string[] {
  return provisioned.length === 0 ? [] : ['--', '.', ...provisioned.map(entry => `:(exclude,literal)${entry}`)];
}

/** True when `relative` is a provisioned path or lies inside a provisioned folder. */
export function isProvisionedPath(provisioned: readonly string[], relative: string): boolean {
  const key = relative.toLowerCase();
  return provisioned.some(entry => {
    const lower = entry.toLowerCase();
    return key === lower || key.startsWith(`${lower}/`);
  });
}
