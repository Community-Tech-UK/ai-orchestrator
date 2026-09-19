import { gitExec } from './git-exec';

/**
 * Active plan/spec/livetest documents stay untracked in the repositories AIO
 * manages: the shared plan-spec guard pre-commit hook refuses to commit them,
 * and only closed-state names (`_completed`, `_archived`) may be tracked. The
 * pattern and the standing-register exemption mirror that hook.
 */
const ACTIVE_PLAN_DOCUMENT_PATTERN = /(_spec|_spec_planned|_plan|_livetest)\.md$/;
const STANDING_REGISTER_MARKER = 'Type: standing register';
const STANDING_REGISTER_HEADER_LINES = 8;

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
    .filter((line) => ACTIVE_PLAN_DOCUMENT_PATTERN.test(line));

  const active: string[] = [];
  for (const candidate of candidates) {
    const content = await gitExec(['show', `${tipRef}:${candidate}`], repoRoot);
    const header = content.split('\n').slice(0, STANDING_REGISTER_HEADER_LINES).join('\n');
    if (!header.includes(STANDING_REGISTER_MARKER)) {
      active.push(candidate);
    }
  }
  return active;
}
