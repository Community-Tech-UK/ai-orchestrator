/**
 * Pure helpers powering SessionArtifactsStripComponent.
 *
 * Lives outside the component so it can be unit-tested without TestBed (the
 * repo's vitest config doesn't include the Angular compiler plugin, so signal
 * `input()` metadata isn't generated and TestBed-based input wiring fails).
 */

import type { Instance } from '../../core/state/instance/instance.types';
import {
  artifactCategory,
  type ArtifactCategory,
} from '../../../../shared/utils/artifact-extensions';
import {
  crossPlatformBasename,
  resolveRelativePath,
} from '../../../../shared/utils/cross-platform-path';

export type ArtifactStatus = 'added' | 'modified' | 'deleted';
export type StatusFilter = 'all' | ArtifactStatus;

export interface ArtifactEntry {
  readonly relPath: string;
  readonly absPath: string;
  readonly basename: string;
  readonly status: ArtifactStatus;
  readonly category: ArtifactCategory;
  readonly added: number;
  readonly deleted: number;
  /** True when the resolved path is outside the working directory. */
  readonly outsideCwd: boolean;
}

export interface ArtifactSummary {
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
}

export const COLLAPSED_STORAGE_PREFIX = 'session-artifacts-strip:collapsed:';

const STATUS_ORDER: Record<ArtifactStatus, number> = {
  added: 0,
  modified: 1,
  deleted: 2,
};

const STATUS_LABEL: Record<ArtifactStatus, string> = {
  added: 'New',
  modified: 'Updated',
  deleted: 'Deleted',
};

/**
 * Build the sorted list of artifact entries from a session's `diffStats`.
 *
 * - Returns `[]` when `diffStats` or `cwd` is missing.
 * - Filters non-artifact files (code, build outputs).
 * - Sort order: New → Updated → Deleted; alphabetical within each group.
 * - Detects entries outside `cwd` via the `..` prefix on the stored relPath
 *   (matches `SessionDiffTracker.computeDiff`'s use of `path.relative`).
 */
export function buildArtifactEntries(
  diffStats: Instance['diffStats'] | null | undefined,
  cwd: string | null | undefined,
): readonly ArtifactEntry[] {
  if (!diffStats || !cwd) return [];

  const items: ArtifactEntry[] = [];
  for (const [relPath, file] of Object.entries(diffStats.files)) {
    const category = artifactCategory(relPath);
    if (!category) continue;

    const status = file.status as ArtifactStatus;
    const absPath = resolveRelativePath(cwd, relPath);
    const outsideCwd = relPath.startsWith('..');

    items.push({
      relPath,
      absPath,
      basename: crossPlatformBasename(relPath),
      status,
      category,
      added: file.added ?? 0,
      deleted: file.deleted ?? 0,
      outsideCwd,
    });
  }

  items.sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    return a.basename.localeCompare(b.basename);
  });

  return items;
}

/** Count entries per status. */
export function summarizeArtifacts(entries: readonly ArtifactEntry[]): ArtifactSummary {
  let added = 0;
  let modified = 0;
  let deleted = 0;
  for (const entry of entries) {
    if (entry.status === 'added') added++;
    else if (entry.status === 'modified') modified++;
    else if (entry.status === 'deleted') deleted++;
  }
  return { added, modified, deleted };
}

/** Apply a status filter pill to an entry list. */
export function applyStatusFilter(
  entries: readonly ArtifactEntry[],
  filter: StatusFilter,
): readonly ArtifactEntry[] {
  if (filter === 'all') return entries;
  return entries.filter((entry) => entry.status === filter);
}

/** Build the hover tooltip for a chip — relPath + status label + line counts. */
export function formatChipTooltip(entry: ArtifactEntry): string {
  const parts = [entry.relPath, STATUS_LABEL[entry.status]];
  if (entry.added > 0) parts.push(`+${entry.added}`);
  if (entry.deleted > 0) parts.push(`-${entry.deleted}`);
  return parts.join(' · ');
}

/**
 * The default click action depends on the artifact category:
 *   - `office` / `image` → open in the system's default app (Preview, Word,
 *     image viewer) because no text editor handles them well.
 *   - everything else → open in the configured text editor.
 */
export function defaultOpenStrategy(category: ArtifactCategory): 'editor' | 'default-app' {
  return category === 'office' || category === 'image' ? 'default-app' : 'editor';
}

/** Format a markdown link suitable for pasting into the next prompt. */
export function formatMarkdownLink(entry: ArtifactEntry): string {
  return `[${entry.basename}](${entry.absPath})`;
}
