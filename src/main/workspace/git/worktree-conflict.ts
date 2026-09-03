/**
 * Cross-worktree conflict detection helpers.
 *
 * Extracted from `worktree-manager.ts` so the manager stays inside its LOC
 * ceiling. Severity / merge-order rules are unchanged.
 */

import type { CrossWorktreeConflict, WorktreeSession } from '../../../shared/types/worktree.types';

export function assessWorktreeConflictSeverity(file: string): 'high' | 'medium' | 'low' {
  const highSeverityPatterns = [
    /package\.json$/,
    /package-lock\.json$/,
    /\.lock$/,
    /schema\./,
    /migration/,
    /index\.(ts|js|tsx|jsx)$/,
  ];

  if (highSeverityPatterns.some((p) => p.test(file))) {
    return 'high';
  }

  if (/\.(ts|js|tsx|jsx|py|go|rs)$/.test(file)) {
    return 'medium';
  }

  return 'low';
}

export function suggestWorktreeMergeOrder(
  session1: WorktreeSession | undefined,
  session2: WorktreeSession | undefined,
  id1: string,
  id2: string,
): string[] {
  if (!session1 || !session2) return [id1, id2];

  if (session1.additions + session1.deletions < session2.additions + session2.deletions) {
    return [id1, id2];
  }
  return [id2, id1];
}

export async function detectCrossWorktreeConflicts(params: {
  sessions: Map<string, WorktreeSession>;
  currentId: string;
  currentFiles: string[];
  getWorktreeStats: (session: WorktreeSession) => Promise<{ filesChanged: string[] }>;
}): Promise<CrossWorktreeConflict[]> {
  const { sessions, currentId, currentFiles, getWorktreeStats } = params;
  const conflicts: CrossWorktreeConflict[] = [];

  for (const [id, session] of sessions) {
    if (id === currentId) continue;
    if (!['active', 'completed'].includes(session.status)) continue;

    const otherFiles =
      session.filesChanged.length > 0 ? session.filesChanged : (await getWorktreeStats(session)).filesChanged;

    const overlap = currentFiles.filter((f) => otherFiles.includes(f));

    for (const file of overlap) {
      const existing = conflicts.find((c) => c.file === file);
      if (existing) {
        existing.worktrees.push(id);
      } else {
        conflicts.push({
          file,
          worktrees: [currentId, id],
          description: `File modified in multiple worktrees: ${file}`,
          severity: assessWorktreeConflictSeverity(file),
          mergeOrder: suggestWorktreeMergeOrder(sessions.get(currentId), sessions.get(id), currentId, id),
        });
      }
    }
  }

  return conflicts;
}
