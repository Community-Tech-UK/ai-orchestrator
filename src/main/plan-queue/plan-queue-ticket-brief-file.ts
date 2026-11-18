/**
 * The brief file: `<Harness's data folder>/briefs/<item id>.md`. It holds the whole brief, which a prompt may have had
 * to cut, so a session can read the rest. One function writes it and one deletes it.
 *
 * The brief is other people's text. The file is for the owner only, replaced whole each time, and never inside a
 * repository or a work folder: a session commits what is in its work folder, and a brief there would end up in Git.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getPlanQueueDataDir } from './plan-queue-data-dir';

/** Item ids are made by Harness; anything that could name another folder is refused. */
const ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

function requireItemId(itemId: string): void {
  if (!ITEM_ID_PATTERN.test(itemId)) throw new Error('A ticket brief needs a plain item id.');
}

/** Where an item's brief file is, whether or not it has been written. */
export function ticketBriefPath(itemId: string): string {
  requireItemId(itemId);
  return path.join(getPlanQueueDataDir(), 'briefs', `${itemId}.md`);
}

/** The real path of a place that may not exist yet: the nearest folder that does, resolved, with the rest put back on. */
async function resolvedPath(target: string): Promise<string> {
  const rest: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...rest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...rest);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Writes the brief and returns its path. Refuses a path that resolves inside the run's repository or the item's work
 * folder, before it creates anything. The file is written whole to a private name and moved into place, so a reader
 * sees the old brief or the new one and never half of either.
 */
export async function writeTicketBriefFile(input: { itemId: string; brief: string; repoRoot: string; workFolder: string | null }): Promise<string> {
  const file = ticketBriefPath(input.itemId);
  const place = await resolvedPath(file);
  for (const forbidden of [input.repoRoot, input.workFolder]) {
    if (forbidden && isInside(place, await resolvedPath(forbidden))) throw new Error('A ticket brief is never written inside a repository or a work folder.');
  }
  const folder = path.dirname(file);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const temporary = path.join(folder, `.${input.itemId}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(temporary, input.brief, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return file;
}

/** Deletes an item's brief file. There is nothing to do when it was never written or is already gone. */
export async function deleteTicketBriefFile(itemId: string): Promise<void> {
  await fs.rm(ticketBriefPath(itemId), { force: true });
}

/** A half-written brief (the private name `writeTicketBriefFile` uses) is left alone this long, in case its write is still running. */
export const TICKET_BRIEF_TEMPORARY_FILE_GRACE_MS = 60 * 60_000;

/**
 * Deletes every brief file whose item `keep` does not name, and every half-written one older than the grace time, so a delete
 * that was interrupted is finished later. Returns how many files it removed. A folder that does not exist has nothing to remove.
 */
export async function sweepTicketBriefFiles(keep: (itemId: string) => boolean, now: number): Promise<number> {
  const folder = path.dirname(ticketBriefPath('x'));
  let names: string[];
  try {
    names = await fs.readdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    const brief = /^([A-Za-z0-9_-]{1,100})\.md$/.exec(name);
    const unwanted = brief
      ? !keep(brief[1])
      : name.endsWith('.tmp') && now - (await fs.stat(path.join(folder, name)).then((stat) => stat.mtimeMs, () => now)) > TICKET_BRIEF_TEMPORARY_FILE_GRACE_MS;
    if (!unwanted) continue;
    await fs.rm(path.join(folder, name), { force: true });
    removed += 1;
  }
  return removed;
}
