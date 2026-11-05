/**
 * James's saved checklist for a project folder (`planQueueFolderChecklists`).
 *
 * The commands a run's gates execute come from this saved list when the run's
 * folder has one. A caller of `plan_queue_start` can name gates only for a
 * folder with no saved list: it can never replace a saved one, because the
 * post-merge commands run in a shell. The setting is operator-only (see
 * `settings-control-policy.ts`), so an agent cannot edit the list either.
 */

import {
  DEFAULT_PLAN_QUEUE_FOLDER_CHECKLISTS,
  normalizeChecklistFolder,
  type PlanQueueFolderChecklist,
  type PlanQueueRunConfig,
} from '@contracts/schemas/plan-queue';
import { getSettingsManager } from '../core/config/settings-manager';

type GateConfig = Pick<PlanQueueRunConfig, 'verifierGates' | 'postMergeGate'>;

export interface RunGates extends GateConfig {
  /** The caller passed gates that the folder's saved checklist replaced. */
  callerGatesSetAside: boolean;
}

/** The saved lists, read live from settings. */
export function readSavedFolderChecklists(): PlanQueueFolderChecklist[] {
  return getSettingsManager().getAll().planQueueFolderChecklists ?? DEFAULT_PLAN_QUEUE_FOLDER_CHECKLISTS;
}

/** The same spelling rule the setting's one-entry-per-folder check uses, so a saved entry can never be shadowed by another. */
function sameFolder(a: string, b: string): boolean {
  return normalizeChecklistFolder(a) === normalizeChecklistFolder(b);
}

/**
 * The saved checklist for a run, or null when none applies. The folder the run
 * was started in wins, then the top folder of its Git project, so an entry for
 * either one is used.
 */
export function savedChecklistFor(lists: readonly PlanQueueFolderChecklist[], repoRoot: string, startFolder?: string): PlanQueueFolderChecklist | null {
  const exact = startFolder ? lists.find((list) => sameFolder(list.folder, startFolder)) : undefined;
  return exact ?? lists.find((list) => sameFolder(list.folder, repoRoot)) ?? null;
}

/**
 * The gates a run starts with. A saved checklist for the folder wins outright,
 * both lists, whatever the caller passed. Without one, the caller's gates
 * replace the defaults, as before.
 */
export function resolveRunGates(
  defaults: GateConfig,
  callerConfig: Partial<GateConfig> | undefined,
  saved: PlanQueueFolderChecklist | null,
): RunGates {
  const callerVerifier = callerConfig?.verifierGates;
  const callerPostMerge = callerConfig?.postMergeGate;
  if (!saved) {
    return { verifierGates: callerVerifier ?? defaults.verifierGates, postMergeGate: callerPostMerge ?? defaults.postMergeGate, callerGatesSetAside: false };
  }
  const differs = (caller: readonly string[] | undefined, own: readonly string[]): boolean =>
    caller !== undefined && JSON.stringify(caller) !== JSON.stringify(own);
  return {
    verifierGates: [...saved.verifierGates],
    postMergeGate: [...saved.postMergeGate],
    callerGatesSetAside: differs(callerVerifier, saved.verifierGates) || differs(callerPostMerge, saved.postMergeGate),
  };
}
