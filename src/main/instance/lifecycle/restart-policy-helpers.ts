/**
 * RestartPolicyHelpers — Utility functions for restart/respawn flows.
 *
 * Extracted from instance-lifecycle.ts to isolate the helper logic that
 * multiple restart paths share: session boundary messages, backend state
 * resets, archive snapshots, fallback history construction.
 *
 * Not a singleton — accepts dependencies via constructor injection.
 */

import type { Instance, OutputMessage } from '../../../shared/types/instance.types';
import type { ConversationEndStatus } from '../../../shared/types/history.types';
import type { CliType } from '../../cli/cli-detection';
import { getProviderModelContextWindow } from '../../../shared/types/provider.types';
import { generateId } from '../../../shared/utils/id-generator';
import { buildReplayContinuityMessage as buildSharedReplayContinuityMessage } from '../../session/replay-continuity';
import { buildFallbackHistoryMessage } from '../../session/fallback-history';
import { getLogger } from '../../logging/logger';

const logger = getLogger('RestartPolicyHelpers');

/** Narrow deps this helper set requires. */
export interface RestartPolicyDeps {
  /** Load persisted messages for an instance. */
  loadMessages: (instanceId: string) => Promise<OutputMessage[]>;
  /** Archive an instance snapshot to history. */
  archiveInstance: (instance: Instance, finalStatus: ConversationEndStatus) => Promise<void>;
  /** Reset the compaction budget tracker for an instance. */
  resetBudgetTracker: (instanceId: string) => void;
  /** Clear first-message tracking flag for an instance. */
  clearFirstMessageTracking: (instanceId: string) => void;
  /** Delete the diff tracker for an instance. */
  deleteDiffTracker?: (instanceId: string) => void;
  /** Set a new diff tracker for an instance. */
  setDiffTracker?: (instanceId: string, workingDirectory: string) => void;
}

/** Accessor for active (non-archived) messages from an instance's output buffer. */
export interface ActiveMessageAccessor {
  getActiveMessages: (input: Pick<Instance, 'outputBuffer' | 'archivedUpToMessageId'>) => OutputMessage[];
}

export class RestartPolicyHelpers {
  constructor(
    private readonly deps: RestartPolicyDeps,
    private readonly activeMessages: ActiveMessageAccessor,
  ) {}

  /**
   * Build a replay continuity message for the given instance.
   * Falls back to a generic continuity notice if the shared builder returns empty.
   */
  buildReplayContinuityMessage(instance: Instance, reason: string): string {
    return buildSharedReplayContinuityMessage(this.activeMessages.getActiveMessages(instance), { reason })
      || [
        '[SYSTEM CONTINUITY NOTICE]',
        `Native resume is unavailable for this provider. Continuity mode is replay-based (${reason}).`,
        'Continue the previous task and ask for clarification only if essential context is missing.',
        '[END CONTINUITY NOTICE]',
      ].join('\n');
  }

  /**
   * Build a rich fallback history message when --resume fails.
   * Merges live + historical messages, deduplicates, then creates a
   * token-budget-aware recovery message.
   */
  async buildFallbackHistory(instance: Instance, reason: string): Promise<string> {
    const historicalMessages = await this.deps.loadMessages(instance.id);

    // Merge historical + live, dedup by message ID
    const merged = [...historicalMessages, ...instance.outputBuffer];
    const seenIds = new Set<string>();
    const deduped: OutputMessage[] = [];
    for (const m of merged) {
      if (seenIds.has(m.id)) continue;
      seenIds.add(m.id);
      deduped.push(m);
    }
    const activeMessages = this.activeMessages.getActiveMessages({
      outputBuffer: deduped,
      archivedUpToMessageId: instance.archivedUpToMessageId,
    });

    // Get context window for budget calculation
    const contextWindow = getProviderModelContextWindow(instance.provider, instance.currentModel);

    const fallback = buildFallbackHistoryMessage(activeMessages, reason, contextWindow);
    if (fallback) return fallback;

    // Final fallback: use old summary-based method
    return this.buildReplayContinuityMessage(instance, reason);
  }

  /**
   * Create a session boundary marker message for the output buffer.
   */
  createSessionBoundaryMessage(): OutputMessage {
    return {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content: '— Previous session archived —',
      metadata: {
        kind: 'session-boundary',
        archived: true,
      },
    };
  }

  /**
   * Reset backend session state (context usage, diff stats, compaction budget).
   */
  resetBackendSessionState(
    instance: Instance,
    cliType: CliType,
    options?: { resetTotalTokensUsed?: boolean; resetFirstMessageTracking?: boolean },
  ): void {
    instance.contextUsage = {
      used: 0,
      total: getProviderModelContextWindow(cliType, instance.currentModel),
      percentage: 0,
    };
    instance.diffStats = undefined;
    if (options?.resetTotalTokensUsed) {
      instance.totalTokensUsed = 0;
    }

    if (options?.resetFirstMessageTracking) {
      this.deps.clearFirstMessageTracking(instance.id);
    }
    this.deps.resetBudgetTracker(instance.id);
    this.deps.deleteDiffTracker?.(instance.id);
    this.deps.setDiffTracker?.(instance.id, instance.workingDirectory);
  }

  /**
   * Archive a snapshot of the instance's conversation before restart.
   * Skips child instances and empty conversations.
   */
  async archiveRestartSnapshot(instance: Instance, messages: OutputMessage[]): Promise<void> {
    if (instance.parentId || messages.length === 0) {
      return;
    }

    const archivedInstance: Instance = {
      ...instance,
      id: `${instance.id}-restart-archive-${Date.now()}`,
      outputBuffer: [...messages],
      childrenIds: [...instance.childrenIds],
      subscribedTo: [...instance.subscribedTo],
      communicationTokens: new Map(instance.communicationTokens),
      archivedUpToMessageId: undefined,
    };

    await this.deps.archiveInstance(archivedInstance, 'completed');
  }
}
