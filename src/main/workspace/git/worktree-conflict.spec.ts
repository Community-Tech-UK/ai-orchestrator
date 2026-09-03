import { describe, expect, it } from 'vitest';
import type { WorktreeSession } from '../../../shared/types/worktree.types';
import {
  assessWorktreeConflictSeverity,
  detectCrossWorktreeConflicts,
  suggestWorktreeMergeOrder,
} from './worktree-conflict';

function session(partial: Partial<WorktreeSession> & Pick<WorktreeSession, 'id'>): WorktreeSession {
  return {
    instanceId: 'inst-1',
    worktreePath: `/tmp/${partial.id}`,
    branchName: partial.id,
    baseBranch: 'main',
    baseCommit: 'abc',
    taskDescription: 'task',
    taskType: 'feature',
    status: 'active',
    filesChanged: [],
    commits: [],
    additions: 0,
    deletions: 0,
    lastActivity: 0,
    createdAt: 0,
    ...partial,
  };
}

describe('worktree-conflict', () => {
  it('rates lockfiles high and source files medium', () => {
    expect(assessWorktreeConflictSeverity('package.json')).toBe('high');
    expect(assessWorktreeConflictSeverity('src/foo.ts')).toBe('medium');
    expect(assessWorktreeConflictSeverity('README.md')).toBe('low');
  });

  it('prefers the smaller delta as the first merge', () => {
    expect(suggestWorktreeMergeOrder(
      session({ id: 'a', additions: 1, deletions: 0 }),
      session({ id: 'b', additions: 10, deletions: 2 }),
      'a',
      'b',
    )).toEqual(['a', 'b']);
    expect(suggestWorktreeMergeOrder(undefined, undefined, 'a', 'b')).toEqual(['a', 'b']);
  });

  it('reports overlapping files across active worktrees', async () => {
    const sessions = new Map<string, WorktreeSession>([
      ['a', session({ id: 'a', filesChanged: ['src/foo.ts'] })],
      ['b', session({ id: 'b', filesChanged: ['src/foo.ts', 'README.md'] })],
      ['c', session({ id: 'c', status: 'abandoned', filesChanged: ['src/foo.ts'] })],
    ]);

    const conflicts = await detectCrossWorktreeConflicts({
      sessions,
      currentId: 'a',
      currentFiles: ['src/foo.ts'],
      getWorktreeStats: async () => ({ filesChanged: [] }),
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].file).toBe('src/foo.ts');
    expect(conflicts[0].worktrees).toEqual(['a', 'b']);
    expect(conflicts[0].severity).toBe('medium');
  });
});
