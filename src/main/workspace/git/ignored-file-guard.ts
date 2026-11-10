/**
 * ignored-file-guard — stop Git replacing files it ignores in a folder someone works in.
 *
 * Git treats ignored files as disposable: a fast-forward, merge or branch switch that brings in a tracked file
 * where an ignored one sits replaces it without asking, and an aborted merge can then delete it.
 * `--no-overwrite-ignore` makes fast-forwards and branch switches refuse instead. `git pull` does not take that
 * option, so callers use {@link fastForwardPullCommands}. A three-way merge ignores it (checked on git 2.54), so
 * callers that merge compare the merge result with the folder's ignored files first.
 */
import { execFile } from 'child_process';
import { lstat } from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { getLogger, MAX_LOG_ARRAY_ITEMS } from '../../logging/logger';
import { IGNORED_FILES_UNCHECKED_REASON, ignoredFilesReason } from '../../../shared/copy/ignored-files-copy';
import { hermeticGitEnv } from './git-env';

const execFileAsync = promisify(execFile);
const logger = getLogger('IgnoredFileGuard');

/** Makes `git merge --ff-only`, `git checkout` and `git switch` refuse to replace a file Git ignores. */
export const NO_OVERWRITE_IGNORE = '--no-overwrite-ignore';

/** Settings that change how Git reads pathspecs; the `:(literal,icase)` ones below must keep their meaning. */
const PATHSPEC_ENV = ['GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS'];

type PlaceKind = 'missing' | 'folder' | 'other';

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const env = hermeticGitEnv(process.env, cwd);
  for (const key of PATHSPEC_ENV) delete env[key];
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  return stdout;
}

function entries(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

/**
 * The tree a three-way merge of `incoming` into HEAD would leave in `checkout`, conflicted files included. The
 * merge moves the working tree from HEAD to this tree, so it is what {@link ignoredFilesInTheWay} checks.
 */
export async function mergeResultTree(checkout: string, incoming: string): Promise<string> {
  let output: string;
  try {
    output = await gitOutput(['merge-tree', '--write-tree', '--no-messages', 'HEAD', incoming], checkout);
  } catch (error) {
    // Exit 1 means the merge conflicts, and the tree is printed all the same. It also
    // means a name Git cannot merge, which prints no tree, so the tree is checked below.
    const { code, stdout } = error as { code?: unknown; stdout?: unknown };
    if (code !== 1 || typeof stdout !== 'string') throw error;
    output = stdout;
  }
  const tree = output.split('\n')[0].trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree)) {
    throw new Error(`git merge-tree gave no merge result for ${incoming}`);
  }
  return tree;
}

/**
 * Where something already sits on the way to each path: the first part of it that is not a folder, or the path
 * itself. A folder sitting at a path ends with `/`.
 */
async function occupiedPlaces(checkout: string, paths: readonly string[]): Promise<string[]> {
  const kinds = new Map<string, Promise<PlaceKind>>();
  const kindOf = (place: string): Promise<PlaceKind> => {
    let kind = kinds.get(place);
    if (!kind) {
      kind = lstat(path.join(checkout, place)).then(
        (stats): PlaceKind => (stats.isDirectory() ? 'folder' : 'other'),
        (error: NodeJS.ErrnoException): PlaceKind => {
          if (error.code === 'ENOENT') return 'missing';
          throw error;
        },
      );
      kinds.set(place, kind);
    }
    return kind;
  };
  const places = new Set<string>();
  for (const file of paths) {
    const parts = file.split('/');
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const place = parts.slice(0, depth).join('/');
      const kind = await kindOf(place);
      if (kind === 'missing') break;
      if (kind === 'other') {
        places.add(place);
        break;
      }
      if (depth === parts.length) places.add(`${place}/`);
    }
  }
  return [...places];
}

/**
 * Places in `checkout` where moving its working tree from HEAD to `target` (a commit or a tree) would replace files
 * Git ignores: an ignored file where `target` adds a file, an ignored file where it needs a folder, or a folder
 * holding ignored files where it adds a file (named with a trailing `/`).
 */
export async function ignoredFilesInTheWay(checkout: string, target: string): Promise<string[]> {
  const added = entries(await gitOutput(
    ['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--diff-filter=A', 'HEAD', target],
    checkout,
  ));
  const places = await occupiedPlaces(checkout, added);
  if (!places.length) return [];
  const bare = (place: string) => place.replace(/\/$/, '');
  // Matched without regard to case: on a case-insensitive disk an added `Notes.md` lands on an ignored `notes.md`.
  const ignored = entries(await gitOutput(
    ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--',
      ...places.map((place) => `:(literal,icase)${bare(place)}`)],
    checkout,
  )).map((file) => file.toLowerCase());
  return places.filter((place) => {
    const key = bare(place).toLowerCase();
    // A nested repository is listed as its own folder, ending in `/`, even when the place is inside it.
    return ignored.some((file) => file === key || file.startsWith(`${key}/`) || (file.endsWith('/') && key.startsWith(file)));
  });
}

/**
 * Why moving `checkout` from HEAD to `target` must not go ahead because of files Git ignores, or null when it
 * may. When Git cannot answer, the move does not go ahead either, and the error goes to the log.
 */
export async function ignoredFilesBlockReason(checkout: string, target: string): Promise<string | null> {
  try {
    const places = await ignoredFilesInTheWay(checkout, target);
    if (!places.length) return null;
    // The reason names only the first few, so the log keeps every place, in parts it will not shorten.
    for (let from = 0; from < places.length; from += MAX_LOG_ARRAY_ITEMS) {
      logger.warn('Files Git ignores are in the way', {
        checkout,
        target,
        total: places.length,
        places: places.slice(from, from + MAX_LOG_ARRAY_ITEMS),
      });
    }
    return ignoredFilesReason(places);
  } catch (error) {
    logger.warn('Could not check for files Git ignores', {
      checkout,
      target,
      message: error instanceof Error ? error.message : String(error),
    });
    return IGNORED_FILES_UNCHECKED_REASON;
  }
}

/**
 * The two commands that stand in for `git pull --ff-only <remote> <ref>`. Like `git pull`, the ref is fetched by
 * name, so a ref gone from the remote fails instead of matching a stale local copy, and FETCH_HEAD then holds
 * exactly what to fast-forward to. `--end-of-options` keeps a remote or ref read from settings from passing as
 * an option.
 */
export function fastForwardPullCommands(remote: string, ref: string): string[][] {
  return [
    ['fetch', '--write-fetch-head', '--end-of-options', remote, ref],
    ['merge', '--ff-only', NO_OVERWRITE_IGNORE, 'FETCH_HEAD'],
  ];
}
