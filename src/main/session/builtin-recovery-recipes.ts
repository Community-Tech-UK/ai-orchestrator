import { getLogger } from '../logging/logger';
import type { RecoveryRecipe, DetectedFailure, RecoveryOutcome } from '../../shared/types/recovery.types';

const logger = getLogger('BuiltinRecoveryRecipes');

/**
 * Returns all built-in recovery recipes.
 * Each recipe is a standalone unit — no shared state between recipes.
 * Recipes that need instance access receive it via failure.context.
 */
export function createBuiltinRecipes(): RecoveryRecipe[] {
  return [
    {
      category: 'thread_resume_failed',
      severity: 'recoverable',
      maxAutoRetries: 3,
      cooldownMs: 0,
      description: 'Advance to next fallback step in the resume chain (cursor → JSONL scan → replay → fresh)',
      async recover(failure: DetectedFailure): Promise<RecoveryOutcome> {
        logger.info('thread_resume_failed: advancing fallback chain', { instanceId: failure.instanceId });
        // The fallback chain in CodexCliAdapter handles this automatically.
        // This recipe just logs and reports — the adapter will try the next step.
        return { status: 'recovered', action: 'Advanced resume fallback chain to next step' };
      },
    },

    {
      category: 'process_exited_unexpected',
      severity: 'recoverable',
      maxAutoRetries: 2,
      cooldownMs: 10_000,
      description: 'Respawn instance with resume cursor, restore from last checkpoint',
      async recover(failure: DetectedFailure): Promise<RecoveryOutcome> {
        logger.info('process_exited_unexpected: requesting respawn', { instanceId: failure.instanceId });
        // Set respawn flag in context for InstanceLifecycle to pick up
        failure.context['requestRespawn'] = true;
        failure.context['useResumeCursor'] = true;
        return { status: 'recovered', action: 'Requested instance respawn with resume cursor' };
      },
    },

    {
      category: 'agent_stuck_blocked',
      severity: 'recoverable',
      maxAutoRetries: 1,
      cooldownMs: 60_000,
      description: 'Send turn/interrupt RPC (app-server) or SIGINT (exec mode), then inject unstuck prompt',
      async recover(failure: DetectedFailure): Promise<RecoveryOutcome> {
        logger.info('agent_stuck_blocked: sending interrupt', { instanceId: failure.instanceId });
        failure.context['sendInterrupt'] = true;
        failure.context['injectMessage'] = 'You appear stuck on an error. Describe what went wrong and try a different approach.';
        return { status: 'recovered', action: 'Sent interrupt and injected unstuck prompt' };
      },
    },

    {
      category: 'agent_stuck_waiting',
      severity: 'degraded',
      maxAutoRetries: 1,
      cooldownMs: 30_000,
      description: 'Notify user via activity bridge; auto-approve if yolo mode is enabled',
      async recover(failure: DetectedFailure): Promise<RecoveryOutcome> {
        const isYolo = failure.context['yoloMode'] === true;
        if (isYolo) {
          failure.context['autoApprove'] = true;
          return { status: 'recovered', action: 'Auto-approved pending request (yolo mode)' };
        }
        return { status: 'degraded', action: 'Notified user of pending approval request' };
      },
    },

    {
      category: 'mcp_server_unreachable',
      severity: 'degraded',
      maxAutoRetries: 3,
      cooldownMs: 30_000,
      description: 'Mark MCP server as degraded (skip, do not crash), retry connection after cooldown',
      async recover(failure: DetectedFailure): Promise<RecoveryOutcome> {
        const serverName = failure.context['serverName'] as string | undefined;
        logger.info('mcp_server_unreachable: marking server degraded', { serverName });
        failure.context['markDegraded'] = true;
        return { status: 'degraded', action: `Marked MCP server "${serverName ?? 'unknown'}" as degraded` };
      },
    },

    {
      category: 'provider_auth_expired',
      severity: 'fatal',
      maxAutoRetries: 0,
      cooldownMs: 0,
      description: 'Escalate immediately — cannot auto-fix credentials',
      async recover(_failure: DetectedFailure): Promise<RecoveryOutcome> {
        return { status: 'escalated', reason: 'Provider authentication expired — manual credential refresh required' };
      },
    },

    {
      category: 'context_window_exhausted',
      severity: 'recoverable',
      maxAutoRetries: 1,
      cooldownMs: 0,
      description: 'Trigger context compaction (existing capability), checkpoint first',
      async recover(failure: DetectedFailure): Promise<RecoveryOutcome> {
        logger.info('context_window_exhausted: requesting compaction', { instanceId: failure.instanceId });
        failure.context['requestCompaction'] = true;
        return { status: 'recovered', action: 'Triggered context compaction' };
      },
    },

    {
      category: 'workspace_disappeared',
      severity: 'recoverable',
      maxAutoRetries: 1,
      cooldownMs: 5_000,
      description: 'Recreate git worktree from branch metadata, restore session',
      async recover(failure: DetectedFailure): Promise<RecoveryOutcome> {
        const branch = failure.context['gitBranch'] as string | undefined;
        if (!branch) {
          return { status: 'escalated', reason: 'Cannot recreate workspace — no branch metadata available' };
        }
        failure.context['recreateWorktree'] = true;
        failure.context['branch'] = branch;
        return { status: 'recovered', action: `Requested worktree recreation for branch "${branch}"` };
      },
    },

    {
      category: 'stale_branch',
      severity: 'degraded',
      maxAutoRetries: 0,
      cooldownMs: 0,
      description: 'Warn user via activity bridge, do not auto-rebase (destructive)',
      async recover(_failure: DetectedFailure): Promise<RecoveryOutcome> {
        return { status: 'degraded', action: 'Branch has diverged significantly from main — manual rebase recommended' };
      },
    },

    {
      category: 'ci_feedback_loop',
      severity: 'degraded',
      maxAutoRetries: 0,
      cooldownMs: 0,
      description: 'After 3 consecutive CI failures on same issue, pause agent and escalate with summary',
      async recover(failure: DetectedFailure): Promise<RecoveryOutcome> {
        const failCount = failure.context['consecutiveFailures'] as number | undefined;
        failure.context['pauseAgent'] = true;
        return {
          status: 'escalated',
          reason: `Agent has failed CI ${failCount ?? '3+'} consecutive times on the same issue — pausing for human review`,
        };
      },
    },
  ];
}
