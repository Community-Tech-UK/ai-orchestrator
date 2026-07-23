/**
 * Pure view-model helpers for the Source Control change list.
 *
 * VS Code's SCM view merges untracked files into a single "Changes" group
 * (its default `git.untrackedChanges: mixed`), sorted by name with untracked
 * entries interleaved rather than pushed into a separate group. This module
 * builds that merged, name-sorted row list from the renderer's
 * `GitStatusResponse` without touching git behaviour or the IPC contract —
 * `untracked` (plain path strings) become synthetic `FileChange` rows.
 */

import type {
  FileChange,
  FileChangeStatus,
  GitStatusResponse,
} from './source-control.types';

/** Basename of a repo-relative path, for case-insensitive name sorting. */
function basename(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * The "Changes" group: unstaged tracked changes plus untracked files, mapped
 * to synthetic `FileChange` rows, sorted case-insensitively by basename
 * (untracked interleaved — VS Code sorts by name, not by status). Ties on
 * basename fall back to the full path so ordering is stable.
 */
export function buildChangesRows(status: GitStatusResponse): FileChange[] {
  const untrackedRows: FileChange[] = status.untracked.map((path) => ({
    path,
    status: 'untracked',
    staged: false,
  }));

  return [...status.unstaged, ...untrackedRows].sort((a, b) => {
    const nameCmp = basename(a.path).localeCompare(basename(b.path), undefined, {
      sensitivity: 'base',
    });
    if (nameCmp !== 0) return nameCmp;
    return a.path.localeCompare(b.path, undefined, { sensitivity: 'base' });
  });
}

/**
 * Single-letter git-status marker shown at the row end, VS Code style:
 * `M` modified, `A` added, `D` deleted, `R` renamed, `C` copied,
 * `U` untracked, `!` ignored.
 */
export function statusLetter(status: FileChangeStatus): string {
  switch (status) {
    case 'added': return 'A';
    case 'modified': return 'M';
    case 'deleted': return 'D';
    case 'renamed': return 'R';
    case 'copied': return 'C';
    case 'untracked': return 'U';
    case 'ignored': return '!';
    default: return '·';
  }
}
