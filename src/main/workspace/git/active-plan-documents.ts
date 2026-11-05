import { gitExec } from './git-exec';
import { declaresStandingRegister, isActivePlanDocumentPath } from './active-plan-pattern';

/**
 * Active plan/spec/livetest documents stay untracked in the repositories AIO
 * manages: the shared plan-spec guard pre-commit hook refuses to commit them,
 * and only closed-state names (`_completed`, `_archived`) may be tracked. The
 * pattern and the standing-register exemption are shared with the Plan Queue
 * (`active-plan-pattern.ts`) and mirror that hook.
 */

/**
 * List the active plan documents that `tipRef` adds or modifies relative to
 * its merge base with `baseRef`.
 *
 * Harvest commits skip repository hooks so session output is never stranded,
 * and integration merges skip them too, so this is the check that keeps an
 * active plan from reaching the base branch through auto-integration.
 */
export async function listActivePlanDocuments(
  repoRoot: string,
  baseRef: string,
  tipRef: string,
): Promise<string[]> {
  const changed = await gitExec(
    ['diff', '--name-only', '--no-renames', '--diff-filter=ACM', `${baseRef}...${tipRef}`],
    repoRoot,
  );
  const candidates = changed
    .split('\n')
    .map((line) => line.trim())
    .filter(isActivePlanDocumentPath);

  const active: string[] = [];
  for (const candidate of candidates) {
    const content = await gitExec(['show', `${tipRef}:${candidate}`], repoRoot);
    if (!declaresStandingRegister(content)) {
      active.push(candidate);
    }
  }
  return active;
}
