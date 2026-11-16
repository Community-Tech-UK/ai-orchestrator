/**
 * James's links from project folders to Linear projects (`planQueueLinearFolderLinks`): the one checked way to save
 * them, and the one reader a later step calls to learn which Linear projects a folder serves.
 *
 * - Saving checks the whole list against the schema, then checks every folder on disk (it exists and is the top folder
 *   of a Git project, compared the way a listed folder is). It saves the whole list or nothing, and gives a plain
 *   reason for every refused row. Saves run one at a time, so two in a row each see the list the other left.
 * - Using a link checks the folder again, every time. A link whose folder has moved or stopped being a Git project is
 *   reported as broken with its reason and is not used. A project that is not linked is never returned.
 * - Nothing here touches `planQueueFolders`. A linked folder may start a run because `plan_queue_start` reads both
 *   settings, not because either is copied into the other.
 */
import { realpath, stat } from 'fs/promises';
import {
  PlanQueueLinearFolderLinkSchema,
  PlanQueueLinearFolderLinksSchema,
  normalizeChecklistFolder,
  type PlanQueueLinearFolderLink,
  type PlanQueueLinearFolderReading,
  type PlanQueueLinearLinkReading,
  type PlanQueueLinearLinkRefusal,
  type PlanQueueLinearLinksSaveResult,
} from '@contracts/schemas/plan-queue';
import { repositoryRoot } from '../plan-queue-git';
import { isProjectTopFolder } from '../plan-queue-saved-folders';

export interface LinearFolderLinkDependencies {
  /** The saved list, read live on every call. */
  readLinks(): readonly PlanQueueLinearFolderLink[];
  /** Writes the whole list through the settings manager and announces the change so the page updates. */
  saveLinks(links: PlanQueueLinearFolderLink[]): void;
  isDirectory(folder: string): Promise<boolean>;
  /** The top folder of the Git project the folder is in; rejects when it is in none. */
  topFolderOf(folder: string): Promise<string>;
  /** Where the folder really is, for comparing two spellings of one folder. */
  realPathOf(folder: string): Promise<string>;
}

export const realLinearFolderLinkDependencies = (
  parts: Pick<LinearFolderLinkDependencies, 'readLinks' | 'saveLinks'>,
): LinearFolderLinkDependencies => ({
  ...parts,
  isDirectory: (folder) => stat(folder).then((info) => info.isDirectory(), () => false),
  topFolderOf: repositoryRoot,
  realPathOf: (folder) => realpath(folder).catch(() => folder),
});

type FolderCheck = { ok: true; top: string } | { ok: false; reason: string };

/** Whether a folder can be linked now. Used when saving and again every time a link is read. */
async function checkFolder(folder: string, deps: LinearFolderLinkDependencies): Promise<FolderCheck> {
  if (!(await deps.isDirectory(folder))) return { ok: false, reason: `There is no folder at ${folder} on this computer.` };
  let top: string;
  try {
    top = await deps.topFolderOf(folder);
  } catch {
    return { ok: false, reason: `${folder} is not part of a Git project, so no runs can start there.` };
  }
  if (!(await isProjectTopFolder(folder, top)))
    return { ok: false, reason: `${folder} is a folder inside the project at ${top}. Link the project's top folder instead.` };
  return { ok: true, top };
}

/** The schema's own words for a rule it wrote; a plain sentence for anything else, such as a missing field. */
function plainSchemaReason(issue: { code: string; message: string; path: PropertyKey[] }): string {
  if (issue.code === 'custom') return issue.message;
  if (issue.path.length === 0) return 'The list is too long: at most 100 folders can be linked.';
  const field = issue.path.slice(1).map(String).join(' > ');
  return `This row is incomplete or has a value that cannot be saved${field ? ` (${field})` : ''}.`;
}

export class LinearFolderLinkService {
  /** Saves run one at a time: each is checked against the list the one before it left. */
  private saving: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: LinearFolderLinkDependencies) {}

  /** Checks the whole list and saves all of it, or saves nothing and says why for each refused row. */
  save(rows: readonly unknown[]): Promise<PlanQueueLinearLinksSaveResult> {
    const run = this.saving.then(() => this.checkAndSave(rows));
    this.saving = run.catch(() => undefined);
    return run;
  }

  private async checkAndSave(rows: readonly unknown[]): Promise<PlanQueueLinearLinksSaveResult> {
    const refused = new Map<number | null, string[]>();
    const refuse = (index: number | null, reason: string): void => {
      refused.set(index, [...(refused.get(index) ?? []), reason]);
    };

    const whole = PlanQueueLinearFolderLinksSchema.safeParse(rows);
    if (!whole.success) {
      for (const issue of whole.error.issues) {
        const [first] = issue.path;
        refuse(typeof first === 'number' ? first : null, plainSchemaReason(issue));
      }
    }

    // Every well-formed row is checked on disk, so one refusal does not hide the others. A badly formed row already
    // has its reason from the schema check above.
    const topByRow = new Map<number, string>();
    await Promise.all(rows.map(async (row, index) => {
      const parsed = PlanQueueLinearFolderLinkSchema.safeParse(row);
      if (!parsed.success) return;
      const check = await checkFolder(parsed.data.folder, this.deps);
      if (check.ok) topByRow.set(index, check.top);
      else refuse(index, check.reason);
    }));

    // Two spellings of one folder (a link and its target, say) reach the same top folder, so they are one folder.
    const seen = new Map<string, number>();
    for (const [index, top] of [...topByRow].sort((a, b) => a[0] - b[0])) {
      const key = normalizeChecklistFolder(top);
      const first = seen.get(key);
      if (first === undefined) seen.set(key, index);
      else if (!refused.has(index)) refuse(index, `This is the same folder as row ${first + 1}. Each folder can be linked once.`);
    }

    if (!whole.success || refused.size > 0) return { saved: false, refused: flatten(refused) };
    // Every check has finished and passed; this is the one write.
    this.deps.saveLinks(whole.data);
    return { saved: true, links: whole.data };
  }

  /** The saved links, each with its live state. A broken one carries its reason. */
  async readAll(): Promise<PlanQueueLinearLinkReading[]> {
    return Promise.all(this.deps.readLinks().map(async (link) => {
      const check = await checkFolder(link.folder, this.deps);
      return { link, broken: check.ok ? null : check.reason };
    }));
  }

  /**
   * What the saved links say about one folder, checked again now. Returns the linked projects only when the folder is
   * still the top folder of a Git project; a broken link is reported with its reason and is not used; a folder with no
   * link, and any project that is not linked to it, returns nothing.
   */
  async readForFolder(folder: string): Promise<PlanQueueLinearFolderReading> {
    const link = await this.findLink(folder);
    if (!link) return { status: 'none', folder };
    const check = await checkFolder(link.folder, this.deps);
    if (!check.ok) return { status: 'broken', folder: link.folder, reason: check.reason };
    return {
      status: 'linked',
      folder: link.folder,
      privateProject: link.privateProject,
      clientProjects: [...link.clientProjects],
    };
  }

  private async findLink(folder: string): Promise<PlanQueueLinearFolderLink | undefined> {
    const links = this.deps.readLinks();
    const wanted = normalizeChecklistFolder(folder);
    const byName = links.find((link) => normalizeChecklistFolder(link.folder) === wanted);
    if (byName) return byName;
    // Not the same spelling: a folder reached through a link is the same folder as its target.
    const real = normalizeChecklistFolder(await this.deps.realPathOf(folder));
    for (const link of links) {
      if (normalizeChecklistFolder(await this.deps.realPathOf(link.folder)) === real) return link;
    }
    return undefined;
  }
}

function flatten(refused: Map<number | null, string[]>): PlanQueueLinearLinkRefusal[] {
  return [...refused]
    .flatMap(([index, reasons]) => [...new Set(reasons)].map((reason) => ({ index, reason })))
    .sort((a, b) => (a.index ?? -1) - (b.index ?? -1));
}
