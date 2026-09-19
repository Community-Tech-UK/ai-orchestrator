/**
 * Operator-facing view of an AIO-managed loop worktree's finalization
 * lifecycle (harvest → integrate → promote → clean). Pure, like the other
 * loop formatters; rendered by the loop summary and the past-runs panel.
 */
import type { LoopWorktreeLifecycle } from '../../../../shared/types/loop.types';

export interface ManagedWorktreeStatusView {
  tone: 'active' | 'success' | 'blocked' | 'preserved';
  label: string;
  detail: string;
}

const HARVEST_FAILED_REASON = 'Harvest failed with uncommitted work';

function publicWorktreeBlockReason(reason: string | undefined): string {
  if (!reason) return 'manual attention required';
  const exactReasons = new Set([
    'root checkout has uncommitted changes',
    'unable to compare root changes with the promotion',
    'unable to inspect worktree ownership',
    'unable to inspect root checkout branch',
    'unable to inspect root checkout status',
    'checked-out base promotion failed',
    'unchecked base promotion failed',
    HARVEST_FAILED_REASON,
    'Unable to inspect managed worktree status',
    'Session branch metadata is missing',
    'Durable session branch is missing',
    'Managed worktree base branch metadata is missing',
    'Managed worktree integration failed; inspect AIO logs',
    'Managed worktree finalization failed; inspect AIO logs',
    'Managed worktree recovery failed; inspect AIO logs',
    'Managed session branch identity could not be verified',
    'Managed integration branch identity could not be verified',
    'Managed worktree ownership could not be verified',
    'Session adds active plan/spec/livetest documents; land it manually',
    'Session branch changed outside AIO; review it before landing',
  ]);
  if (exactReasons.has(reason)) return reason;
  if (
    /^[A-Za-z0-9._/-]+ cannot be fast-forwarded to [A-Za-z0-9._/-]+$/.test(reason)
    // Repository-relative path only; an absolute path could leak the user's home layout.
    || /^root checkout has uncommitted changes to a promoted path: [^/\s][^\n]{0,299}$/.test(reason)
    || /^[A-Za-z0-9._/-]+ is checked out outside the repository root$/.test(reason)
    || /^(base|integration) branch [A-Za-z0-9._/-]+ does not exist$/.test(reason)
  ) {
    return reason;
  }
  return 'manual attention required; inspect AIO logs';
}

/** Human-facing outcome for AIO-owned worktree finalization. */
export function managedWorktreeStatus(
  lifecycle: LoopWorktreeLifecycle | undefined,
  loopStatus: string,
): ManagedWorktreeStatusView | null {
  if (!lifecycle) return null;
  const branches = [
    lifecycle.sessionBranch,
    lifecycle.integrationBranch,
  ].filter((branch): branch is string => Boolean(branch));

  switch (lifecycle.phase) {
    case 'blocked': {
      const reason = publicWorktreeBlockReason(lifecycle.lastError);
      // A failed harvest means the output was never committed: it exists only
      // in the worktree folder, so claiming it is "saved on" a branch is false.
      const location = lifecycle.lastError === HARVEST_FAILED_REASON
        ? `uncommitted in the ${lifecycle.sessionBranch} worktree folder, not saved on a branch`
        : `saved on ${branches.join(' and ')}`;
      return {
        tone: 'blocked',
        label: lifecycle.integrationBranch ? 'promotion blocked' : 'workspace blocked',
        detail: `${reason} · ${location}`,
      };
    }
    case 'promoted':
      return {
        tone: 'success',
        label: `promoted to ${lifecycle.baseBranch}`,
        detail: lifecycle.integrationBranch
          ? `integrated through ${lifecycle.integrationBranch}`
          : 'base branch fast-forwarded',
      };
    case 'preserved':
      return {
        tone: 'preserved',
        label: 'work preserved',
        detail: `saved on ${lifecycle.sessionBranch}`,
      };
    case 'cleaned': {
      if (lifecycle.resolvedByOperatorAt) {
        return {
          tone: 'preserved',
          label: 'marked resolved',
          detail: `you resolved this workspace by hand; AIO no longer manages ${lifecycle.sessionBranch}`,
        };
      }
      if (lifecycle.integrationBranch && (
        loopStatus === 'completed' || loopStatus === 'completed-needs-review'
      )) {
        return {
          tone: 'success',
          label: `promoted to ${lifecycle.baseBranch}`,
          detail: 'managed workspace cleaned',
        };
      }
      return {
        tone: 'preserved',
        label: 'work preserved',
        detail: `saved on ${lifecycle.sessionBranch} · managed workspace cleaned`,
      };
    }
    case 'integrating':
      return {
        tone: 'active',
        label: 'integrating work',
        detail: `from ${lifecycle.sessionBranch}`,
      };
    case 'integrated':
    case 'promoting':
      return {
        tone: 'active',
        label: 'promotion pending',
        detail: `${lifecycle.integrationBranch ?? lifecycle.sessionBranch} → ${lifecycle.baseBranch}`,
      };
    case 'harvesting':
      return {
        tone: 'active',
        label: 'saving session work',
        detail: lifecycle.sessionBranch,
      };
    case 'harvested':
      return {
        tone: 'active',
        label: 'session work saved',
        detail: lifecycle.sessionBranch,
      };
    case 'acquired':
      return {
        tone: 'active',
        label: 'managed workspace active',
        detail: lifecycle.sessionBranch,
      };
  }
}
