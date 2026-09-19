import type { DirtyRootPolicy } from './worktree-integration';

/**
 * Loop promotion blocks only when the operator's uncommitted root changes
 * overlap the promoted paths. `block-any` could never pass in a repository that
 * keeps untracked working documents in its root (James's decision, 2026-09-18).
 */
export const LOOP_DIRTY_ROOT_POLICY: DirtyRootPolicy = 'block-overlap';
