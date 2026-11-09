/**
 * Plan Queue schemas for James's saved project-folder settings: the checklist for each folder
 * (`planQueueFolderChecklists`) and the folder list (`planQueueFolders`). Re-exported from
 * `plan-queue.schemas.ts`, so callers import them from `@contracts/schemas/plan-queue` as before.
 */
import { z } from 'zod';

/**
 * James's saved checklist for one project folder: the commands Harness runs to
 * check a document before independent review, and after merging a moved base
 * branch. A folder with a saved checklist always uses it; a caller of
 * `plan_queue_start` cannot replace it. Each folder appears once, and a saved
 * checklist names at least one command.
 */
export const PlanQueueFolderChecklistSchema = z.object({
  folder: z.string().trim().min(1).max(1000),
  verifierGates: z.array(z.string().trim().min(1).max(2000)).max(20),
  postMergeGate: z.array(z.string().trim().min(1).max(2000)).max(10),
}).strict().refine((list) => isAbsoluteChecklistFolder(list.folder), {
  message: 'Give the full path of the folder, starting with / or a drive letter such as C:\\.',
}).refine((list) => list.verifierGates.length + list.postMergeGate.length > 0, {
  message: 'A saved checklist needs at least one command.',
});

/**
 * A folder path in one canonical spelling, so two spellings of the same folder
 * compare equal: either slash, repeated slashes, trailing slashes, `.` and `..`
 * segments. Pure string work (no filesystem, no `path` module) because the
 * renderer and the main process must agree on it. Used by the schema's
 * one-entry-per-folder rule, the editor and the run-time lookup.
 */
export function normalizeChecklistFolder(folder: string): string {
  const text = folder.trim();
  const parts = text.split(/[\\/]+/);
  const first = parts[0] ?? '';
  let root = '';
  if (first === '') {
    root = /^[\\/]{2}[^\\/]/.test(text) ? '//' : '/';
    parts.shift();
  } else if (/^[A-Za-z]:$/.test(first)) {
    root = `${first}/`;
    parts.shift();
  }
  const kept: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (kept.length > 0 && kept[kept.length - 1] !== '..') kept.pop();
      else if (root === '') kept.push(part);
    } else {
      kept.push(part);
    }
  }
  return root + kept.join('/');
}

/**
 * True for a full path (`/work/shop`, `C:\work\shop`, `\\server\share`). A relative
 * folder can never equal the folder a run starts in, so it is refused when saved.
 * So is a Windows path with a root but no drive (`\shop`): it normalises to
 * `/shop`, which no run on a Windows drive (`C:/shop`) can match.
 */
export function isAbsoluteChecklistFolder(folder: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\[^\\/])/.test(folder.trim());
}

export const PlanQueueFolderChecklistsSchema = z.array(PlanQueueFolderChecklistSchema).max(50).refine((lists) => {
  const folders = lists.map((list) => normalizeChecklistFolder(list.folder));
  return new Set(folders).size === folders.length;
}, { message: 'Each folder can have one checklist.' });

export const DEFAULT_PLAN_QUEUE_FOLDER_CHECKLISTS: PlanQueueFolderChecklist[] = [];

/**
 * James's saved Plan Queue folder list: the project folders a session may start a run in from another folder, with
 * the `workspace` argument of `plan_queue_start`. Each is a full path, listed once (spellings that mean the same
 * folder count as one).
 */
export const PlanQueueFoldersSchema = z.array(
  z.string().trim().min(1).max(1000).refine(isAbsoluteChecklistFolder, {
    message: 'Give the full path of the folder, starting with / or a drive letter such as C:\\.',
  }),
).max(50).refine((folders) => new Set(folders.map(normalizeChecklistFolder)).size === folders.length, { message: 'Each folder can be listed once.' });

export const DEFAULT_PLAN_QUEUE_FOLDERS: string[] = [];

export type PlanQueueFolderChecklist = z.infer<typeof PlanQueueFolderChecklistSchema>;
