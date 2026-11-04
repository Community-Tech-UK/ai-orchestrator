/**
 * Which verification checklist a run starts with.
 *
 * The default checklist is this repository's own (type-check, lint, builds and tests by npm script).
 * A project that does not define those scripts used to get it anyway and failed with "script not
 * found" (5 runs, 4 items). It now starts with no list, which sends the verifier to the project's
 * own documented checks (plan-queue-prompts.ts), until the caller names its own.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueKind, type PlanQueueRunConfig } from '@contracts/schemas/plan-queue';

const NPM_RUN = /^npm run ([^\s]+)/;

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

/** The run defaults for a project: this repository's checklists where the project can run them, none otherwise. */
export async function defaultRunConfigFor(repoRoot: string, kind: PlanQueueKind): Promise<PlanQueueRunConfig> {
  const defaults = DEFAULT_PLAN_QUEUE_CONFIG[kind];
  const ok = await canRunDefaultGates(repoRoot, [...defaults.verifierGates, ...defaults.postMergeGate]);
  return ok ? defaults : { ...defaults, verifierGates: [], postMergeGate: [] };
}
