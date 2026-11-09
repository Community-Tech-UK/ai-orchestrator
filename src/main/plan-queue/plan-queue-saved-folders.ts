/**
 * James's saved Plan Queue folder list (`planQueueFolders`): the project folders a session may start a run in from
 * another folder, with the `workspace` argument of `plan_queue_start`.
 *
 * The list is an authority setting, edited only on the Plan Queue page. It is operator-only (see
 * `settings-control-policy.ts`), so neither `$AIO_MCP settings` nor any agent-reachable settings tool can add a folder.
 * A session that passes no `workspace` starts in its own folder as before; this list is asked only when it names one.
 */

import { realpath } from 'fs/promises';
import { DEFAULT_PLAN_QUEUE_FOLDERS, isAbsoluteChecklistFolder, normalizeChecklistFolder } from '@contracts/schemas/plan-queue';
import { getSettingsManager } from '../core/config/settings-manager';
import { repositoryRoot } from './plan-queue-git';

/** The saved list, read live from settings. */
export function readSavedPlanQueueFolders(): readonly string[] {
  return getSettingsManager().getAll().planQueueFolders ?? DEFAULT_PLAN_QUEUE_FOLDERS;
}

/**
 * The folder a session asked to start a run in, once it is allowed: a full path that is on the saved list and is the
 * top folder of its Git project. Anything else throws an error whose message says why, in plain words, for the session
 * to pass on. Checked in this order, so an unlisted folder is refused without looking at the disk.
 */
export async function resolveListedWorkspace(
  workspace: string,
  saved: readonly string[],
  topFolderOf: (folder: string) => Promise<string> = repositoryRoot,
): Promise<string> {
  const asked = workspace.trim();
  if (!isAbsoluteChecklistFolder(asked)) {
    throw new Error('The workspace must be a full folder path, starting with / or a drive letter such as C:\\. Leave it out to start in this session\'s own folder.');
  }
  const wanted = normalizeChecklistFolder(asked);
  if (!saved.some((folder) => normalizeChecklistFolder(folder) === wanted)) {
    throw new Error(`${asked} is not on James's Plan Queue folder list, so a session cannot start a run there. `
      + 'Only James can add a folder, on the Plan Queue page. Leave the workspace out to start in this session\'s own folder.');
  }
  const top = await topFolderOf(asked);
  // Git reports the real path, so a folder reached through a link is compared by where it really is.
  const real = await realpath(asked).catch(() => asked);
  if (normalizeChecklistFolder(top) !== normalizeChecklistFolder(real)) {
    throw new Error(`${asked} is a folder inside the project at ${top}. Give the project's top folder as the workspace, and ask James to list that one.`);
  }
  return top;
}
