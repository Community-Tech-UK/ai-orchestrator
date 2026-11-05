/**
 * Which verification checklist a run starts with.
 *
 * The default checklist belongs to this repository alone (type-check, lint, builds and tests by npm
 * script). Any other folder starts with no list, which sends the verifier to the project's own
 * documented checks (plan-queue-prompts.ts), until a saved per-folder list or the caller names one.
 * Giving other projects this repository's list failed them with "script not found" (5 runs, 4 items),
 * and a project that merely defines scripts of the same names still must not run commands chosen for
 * a different codebase.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { gitExecSafe } from '../workspace/git/git-exec';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueKind, type PlanQueueRunConfig } from '@contracts/schemas/plan-queue';

const NPM_RUN = /^npm run ([^\s]+)/;

/**
 * The first commit of this repository's history. Every clone and worktree of the repository has it
 * and no other project does, so (unlike a `package.json` name, which any folder can copy) it says
 * which repository a folder really is. A shallow clone without it counts as another project.
 */
export const THIS_REPOSITORY_ROOT_COMMIT = '3900a11f64419125d858e6fc3e7b87bac1d92f72';

async function isThisRepository(repoRoot: string, rootCommit: string): Promise<boolean> {
  const rootCommits = await gitExecSafe(['rev-list', '--max-parents=0', 'HEAD'], repoRoot);
  return rootCommits.split('\n').includes(rootCommit);
}

async function readScripts(repoRoot: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf-8'));
    const scripts = (parsed as { scripts?: unknown } | null)?.scripts;
    return scripts && typeof scripts === 'object' ? scripts as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(() => true, () => false);
}

/** True when the project can run every command of the default checklist for this kind of run. */
async function canRunDefaultGates(repoRoot: string, commands: readonly string[]): Promise<boolean> {
  const scripts = await readScripts(repoRoot);
  for (const command of commands) {
    const script = NPM_RUN.exec(command)?.[1];
    if (script !== undefined && typeof scripts?.[script] !== 'string') return false;
    if (/\btsc\b/.test(command) && !(await exists(path.join(repoRoot, 'tsconfig.json')))) return false;
  }
  return true;
}

/** The run defaults for a project: this repository's checklists when the folder is this repository and can run them, none otherwise. */
export async function defaultRunConfigFor(
  repoRoot: string,
  kind: PlanQueueKind,
  thisRepositoryRootCommit: string,
): Promise<PlanQueueRunConfig> {
  const defaults = DEFAULT_PLAN_QUEUE_CONFIG[kind];
  const ok = await isThisRepository(repoRoot, thisRepositoryRootCommit)
    && await canRunDefaultGates(repoRoot, [...defaults.verifierGates, ...defaults.postMergeGate]);
  return ok ? defaults : { ...defaults, verifierGates: [], postMergeGate: [] };
}
