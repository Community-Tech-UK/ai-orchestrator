/**
 * Filesystem helpers for detecting the "plan file renamed to _completed.md"
 * signal. Split out of loop-completion-detector.ts to keep the detector focused
 * on observation and verify orchestration. Pure/IO helpers with no detector state.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { isInsideOrEqual } from '../util/path-helpers';
import type { LoopConfig } from '../../shared/types/loop.types';

export function completedPlanFileCandidates(config: Pick<LoopConfig, 'workspaceCwd' | 'planFile'>): string[] {
  if (!config.planFile) return [];
  const workspace = path.resolve(config.workspaceCwd);
  const original = path.resolve(workspace, config.planFile);
  if (!isInsideOrEqual(workspace, original)) return [];
  const ext = path.extname(original);
  if (ext.toLowerCase() !== '.md') return [];
  const stem = original.slice(0, -ext.length);
  return [...new Set([`${stem}_Completed.md`, `${stem}_completed.md`])];
}

/**
 * True iff `filePath` is THIS loop's configured plan file renamed to its
 * `_completed.md` form. The `CompletedFileWatcher` fires for ANY `*_completed.md`
 * rename in the workspace, but a rename is only evidence THIS loop finished when
 * it renamed ITS OWN plan — accepting any rename let an agent complete by
 * renaming an unrelated doc, and let a concurrent loop's plan rename falsely
 * complete this one. Returns false when no plan file is configured (a no-plan
 * loop has nothing to rename and must complete via DONE.txt + verify + ledger).
 * Case-insensitive to match macOS/Windows filesystems and the `[Cc]ompleted`
 * pattern.
 */
export function isCompletedRenameForPlan(
  config: Pick<LoopConfig, 'workspaceCwd' | 'planFile'>,
  filePath: string,
): boolean {
  if (!config.planFile) return false;
  const resolved = path.resolve(filePath).toLowerCase();
  return completedPlanFileCandidates(config).some(
    (candidate) => path.resolve(candidate).toLowerCase() === resolved,
  );
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function resolveActualPathCase(target: string): Promise<string> {
  const dir = path.dirname(target);
  const base = path.basename(target);
  try {
    const entries = await fsp.readdir(dir);
    const exact = entries.find((entry) => entry === base);
    if (exact) return path.join(dir, exact);
    const insensitive = entries.find((entry) => entry.toLowerCase() === base.toLowerCase());
    if (insensitive) return path.join(dir, insensitive);
  } catch {
    // Fall back to the candidate path if the directory cannot be read.
  }
  return target;
}
