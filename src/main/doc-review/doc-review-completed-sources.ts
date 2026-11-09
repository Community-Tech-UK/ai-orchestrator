import { stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';

/**
 * The name a document takes once its work is finished, under the plan and spec
 * lifecycle: `x_plan.md` → `x_plan_completed.md`, `x_spec_planned.md` →
 * `x_spec_completed.md`, `x.md` → `x_completed.md`. Null when the name is
 * already completed.
 */
export function completedDocumentPath(sourcePath: string): string | null {
  const extension = extname(sourcePath);
  const stem = basename(sourcePath, extension);
  if (!stem || stem.endsWith('_completed')) return null;
  return join(dirname(sourcePath), `${stem.replace(/_planned$/, '')}_completed${extension}`);
}

type PathState = 'present' | 'absent' | 'unknown';

async function pathState(path: string): Promise<PathState> {
  try {
    await stat(path);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown';
  }
}

/**
 * True only when a review's source document has been renamed to its completed
 * name: the original is certainly gone and the completed file sits beside it.
 * A moved, deleted or unreadable source proves nothing and returns false.
 */
export async function isReviewSourceCompleted(workspacePath: string, sourcePath: string): Promise<boolean> {
  const source = isAbsolute(sourcePath) ? sourcePath : join(workspacePath, sourcePath);
  const completed = completedDocumentPath(source);
  if (!completed) return false;
  const [sourceState, completedState] = await Promise.all([pathState(source), pathState(completed)]);
  return sourceState === 'absent' && completedState === 'present';
}
