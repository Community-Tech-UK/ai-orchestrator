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
import { retainedPromptsMissingFrom } from '../prompt-retention';
import {
  buildFallbackHistoryMessage,
  buildFreshFallbackDegradationNotice,
  type FreshFallbackDegradationInfo,
} from '../../session/fallback-history';
import { getHandoffStateService } from '../../session/handoff-state-service';
import { getSettingsManager } from '../../core/config/settings-manager';
import { getLogger } from '../../logging/logger';

const logger = getLogger('RestartPolicyHelpers');

/**
 * Diagnostic-only, opt-in observability for the hydration-ladder rung choice.
 * The continuity block is delivered straight into `adapter.sendInput` and was
 * otherwise never logged or reachable — livetest checks 1/3/4 for the rolling
 * handoff-state feature had to guess from a model's own answers, and a long
 * probing session invalidated the instrument (see
 * `docs/superpowers/plans/2026-07-17-rolling-handoff-state-plan_livetest.md`).
 * Mirrors the `AIO_CODEX_CONTEXT_DIAGNOSTICS` opt-in pattern
 * (`codex-app-server-adapter.ts`). Off by default; never mutates behavior.
 */
const HANDOFF_STATE_DIAGNOSTICS_ENABLED = process.env['AIO_HANDOFF_STATE_DIAGNOSTICS'] === '1';

const REDACTION_MARKERS = ['[REDACTED_SK]', '[REDACTED_GHP]', '[REDACTED_SLACK]', '[REDACTED_PRIVATE_KEY]', '[REDACTED]'];

/**
 * Logs which continuity rung was rendered and content-free metadata about it
 * (length, whether a redaction marker fired) unconditionally at debug level.
 * Only emits the actual rendered document text when the diagnostics flag is
 * set, since that document can contain conversation content.
 */
function logHandoffRungChoice(instanceId: string, reason: string, rung: 'maintained-handoff' | 'replay-preamble', document: string): void {
  logger.debug('Continuity rung selected', {
    instanceId,
    reason,
    rung,
    documentChars: document.length,
    containsRedactionMarker: REDACTION_MARKERS.some((marker) => document.includes(marker)),
    ...(HANDOFF_STATE_DIAGNOSTICS_ENABLED ? { document } : {}),
  });
}

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
  /**
   * Optional: reconcile the instance's orchestration children on a fresh
   * fallback (drop dead, keep live) and return them for the degradation
   * notice. Null when the instance has no orchestration context.
   */
  reconcileOrchestrationChildren?: (instanceId: string) => {
    activeChildren: { id: string; name?: string; status?: string }[];
    droppedChildIds: string[];
  } | null;
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
   *
   * Hydration-ladder bottom rung (spec item 5): when
   * `sessionHandoffStateEnabled` is ON, prefer the incrementally maintained
   * handoff document; fall through to the swap-time replay preamble when no
   * state was maintained. OFF ⇒ byte-identical to the historical behavior.
   * Falls back to a generic continuity notice if every builder returns empty.
   */
  buildReplayContinuityMessage(instance: Instance, reason: string): string {
    try {
      if (getSettingsManager().getAll().sessionHandoffStateEnabled) {
        const handoff = getHandoffStateService().buildHandoffDocument(instance, reason);
        if (handoff) {
          logHandoffRungChoice(instance.id, reason, 'maintained-handoff', handoff);
          return handoff;
        }
      }
    } catch (error) {
      logger.warn('Handoff render failed; using replay preamble', {
        instanceId: instance.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Prompts evicted by a buffer trim live beside the buffer, so restore them
    // ahead of the active window — otherwise the preamble's original-request
    // anchor has nothing older than the retained tail to anchor to.
    const activeMessages = this.activeMessages.getActiveMessages(instance);
    const replayMessages = [
      ...retainedPromptsMissingFrom(instance.retainedPrompts, activeMessages),
      ...activeMessages,
    ];
    const replay = buildSharedReplayContinuityMessage(replayMessages, { reason })
      || [
        '[SYSTEM CONTINUITY NOTICE]',
        `Native resume is unavailable for this provider. Continuity mode is replay-based (${reason}).`,
        'Continue the previous task and ask for clarification only if essential context is missing.',
        '[END CONTINUITY NOTICE]',
      ].join('\n');
    logHandoffRungChoice(instance.id, reason, 'replay-preamble', replay);
    return replay;
  }

  /**
   * Build a rich fallback history message when --resume fails.
   * Merges live + historical messages, deduplicates, then creates a
   * token-budget-aware recovery message. Every fresh-fallback path funnels
   * through here, so this is also where the honest degradation notice is
   * appended and orphaned orchestration children are reconciled.
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
    // Prompts evicted by a trim are on disk only when disk storage is on and
    // its fire-and-forget write succeeded, and compaction never writes at all —
    // so the retained set is the only guaranteed source for the original ask.
    const missingPrompts = retainedPromptsMissingFrom(instance.retainedPrompts, deduped);
    if (missingPrompts.length > 0) {
      deduped.push(...missingPrompts);
      deduped.sort((a, b) => a.timestamp - b.timestamp);
    }
    const activeMessages = this.activeMessages.getActiveMessages({
      outputBuffer: deduped,
      archivedUpToMessageId: instance.archivedUpToMessageId,
    });

    // Get context window for budget calculation
    const contextWindow = getProviderModelContextWindow(instance.provider, instance.currentModel);

    const degradationNotice = buildFreshFallbackDegradationNotice(
      reason,
      this.reconcileChildren(instance.id),
    );
    return buildFallbackHistoryMessage(
      activeMessages,
      reason,
      contextWindow,
      0.3,
      degradationNotice,
    ) ?? `${this.buildReplayContinuityMessage(instance, reason)}\n\n${degradationNotice}`;
  }

  /**
   * Best-effort child reconciliation for the degradation notice — a broken
   * orchestration registry must never block session recovery.
   */
  private reconcileChildren(instanceId: string): FreshFallbackDegradationInfo {
    try {
      const result = this.deps.reconcileOrchestrationChildren?.(instanceId);
      if (result) {
        return { activeChildren: result.activeChildren, droppedChildIds: result.droppedChildIds };
      }
    } catch (error) {
      logger.warn('Orchestration child reconciliation failed during fresh fallback', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {};
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
