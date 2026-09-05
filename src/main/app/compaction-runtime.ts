import { ContextCompactor } from '../context/context-compactor';
import {
  getCompactionCoordinator,
  type CompactionResult,
  type ContextPolicyEvent,
} from '../context/compaction-coordinator';
import { getContextEngine } from '../context/context-engine';
import { exchangesToMessageBoundary, groupExchanges } from '../context/compaction-boundary';
import { loadAuthenticatedEvidencePreviews } from '../context/compaction-evidence-preview';
import type { ProviderContextCapabilities } from '@contracts/types/context-evidence';
import { getSettingsManager } from '../core/config/settings-manager';
import { getHookManager } from '../hooks/hook-manager';
import { getLogger } from '../logging/logger';
import { estimateTokens as sharedEstimateTokens } from '../../shared/utils/token-estimate';
import { getRLMDatabase } from '../persistence/rlm-database';
import {
  recordCompactionMarker,
  type RecordCompactionMarkerParams,
} from '../persistence/rlm/rlm-compaction-markers';
import { getCheckpointManager } from '../session/checkpoint-manager';
import { CheckpointType } from '../../shared/types/error-recovery.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import type { ContextUsage, Instance } from '../../shared/types/instance.types';
import type { CompactionBoundaryOptions } from '../../shared/types/compaction-preview.types';
import { getConversationLedgerService } from '../conversation-ledger';
import {
  ProviderContextActionExecutor,
  type ProviderContextActionHandlerResult,
  type ProviderContextExecutableAction,
} from '../context-evidence/provider-context-action-executor';

const logger = getLogger('CompactionRuntime');

/**
 * Checkpoint created by `applyCompaction()` (WS-B7) just before triggering
 * this instance's compaction, consumed (and attached to the compaction
 * boundary message) by the `compaction-completed` listener below. Cleared
 * defensively by `applyCompaction()` itself in case no event fires (e.g. the
 * "already in progress" early return).
 */
const pendingManualCheckpoints = new Map<string, string>();

interface NativeCompactionAdapter {
  compactContext?: () => Promise<boolean>;
  /**
   * True once this adapter has proven, within its own lifetime, that the
   * connected provider build accepts a compact RPC but never confirms it
   * (LT-017's per-adapter sticky flag). Read immediately after a failed
   * `compactContext()` call so the coordinator-level record (LT-045, which
   * survives an adapter respawn) can distinguish "confirmed unsupported"
   * from an ordinary transient failure.
   */
  nativeCompactionKnownUnsupported?: () => boolean;
  getContextCapabilities?: () => ProviderContextCapabilities;
  executeContextAction?: (
    action: ProviderContextExecutableAction,
  ) => Promise<ProviderContextActionHandlerResult>;
  setContextActionProofRecorder?: (
    recorder: ((
      action: string,
      stage: 'requested' | 'acknowledged' | 'observed',
    ) => void) | null,
  ) => void;
}

type CompactionMarkerRecorder = (params: RecordCompactionMarkerParams) => string | null | undefined;

let compactionMarkerRecorder: CompactionMarkerRecorder = recordCompactionMarkerToRlm;

export function setCompactionMarkerRecorderForTesting(
  recorder: CompactionMarkerRecorder | null,
): void {
  compactionMarkerRecorder = recorder ?? recordCompactionMarkerToRlm;
}

function buildPostCompactionUsage(previousUsage: ContextUsage): ContextUsage {
  return {
    used: 0,
    total: previousUsage.total,
    percentage: 0,
    ...(previousUsage.cumulativeTokens !== undefined
      ? { cumulativeTokens: previousUsage.cumulativeTokens }
      : {}),
    ...(previousUsage.costEstimate !== undefined
      ? { costEstimate: previousUsage.costEstimate }
      : {}),
    // LT-018: a post-compaction `used: 0` is a real measurement — the context
    // genuinely was reset — so occupancy stays *reported* if it was before.
    // Dropping the flag here would blank the ring to "no data" after every
    // compaction on providers that do report occupancy.
    ...(previousUsage.occupancyReported ? { occupancyReported: true } : {}),
    // LT-034: compaction does not change what the provider is capable of
    // reporting, so an aggregate-only session is still aggregate-only
    // afterwards. This function rebuilds the object field by field — the same
    // shape that silently dropped `occupancyReported` and would have regressed
    // LT-018 — so the flag has to be carried explicitly here too.
    ...(previousUsage.occupancyIsAggregate ? { occupancyIsAggregate: true } : {}),
    source: 'post-compaction-reset',
    isEstimated: true,
  };
}

function recordCompactionMarkerToRlm(params: RecordCompactionMarkerParams): string | null {
  try {
    return recordCompactionMarker(getRLMDatabase().getRawDb(), params);
  } catch (error) {
    logger.warn('Failed to record compaction marker', {
      instanceId: params.instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function recordCompactionBoundary(
  instanceId: string,
  instance: Instance,
  result: CompactionResult,
): string | null {
  const createdAt = Date.now();
  return compactionMarkerRecorder({
    instanceId,
    threadId: instance.providerSessionId || instance.sessionId || null,
    projectKey: instance.workingDirectory,
    method: result.method,
    createdAt,
    utilizationBefore: result.previousUsage?.percentage ?? null,
    utilizationAfter: result.newUsage?.percentage ?? null,
    ledgerAnchor: createdAt,
    metadata: {
      previousUsage: result.previousUsage ?? null,
      newUsage: result.newUsage ?? null,
    },
  }) ?? null;
}

export function recordProviderThreadCompactionMarker(params: {
  instanceId: string;
  instance?: Instance | null;
  provider?: string;
  sessionId?: string;
  messageId?: string;
  createdAt?: number;
  messageMetadata?: Record<string, unknown>;
}): string | null {
  const createdAt = params.createdAt ?? Date.now();
  const usage = params.instance?.contextUsage;
  getCompactionCoordinator().recordObservedCompaction(
    params.instanceId,
    usage?.cumulativeTokens ?? 0,
  );
  return compactionMarkerRecorder({
    instanceId: params.instanceId,
    threadId: params.sessionId || params.instance?.providerSessionId || params.instance?.sessionId || null,
    projectKey: params.instance?.workingDirectory ?? null,
    method: 'self-managed',
    createdAt,
    utilizationBefore: null,
    utilizationAfter: usage?.percentage ?? null,
    ledgerAnchor: createdAt,
    metadata: {
      source: 'provider-thread-compacted',
      provider: params.provider ?? params.instance?.provider ?? null,
      messageId: params.messageId ?? null,
      contextUsage: usage ?? null,
      messageMetadata: params.messageMetadata ?? null,
    },
  }) ?? null;
}

export function setupCompactionCoordinator(
  instanceManager: InstanceManager,
  windowManager: WindowManager,
): void {
  const coordinator = getCompactionCoordinator();

  // Cost-cap compaction trigger (claude2_todo #34b): apply the current setting
  // and keep it live across changes. Default 0 = disabled.
  const settings = getSettingsManager();
  const applyCumulativeTrigger = () => {
    try {
      coordinator.setCumulativeTokenTrigger(settings.get('cumulativeTokenCompactionTrigger') ?? 0);
    } catch (error) {
      logger.warn('Failed to apply cumulative-token compaction trigger setting', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  applyCumulativeTrigger();
  settings.on('setting-changed', applyCumulativeTrigger);

  coordinator.configure({
    getContextCapabilities: (instanceId: string) => {
      const adapter = instanceManager.getAdapter(instanceId) as NativeCompactionAdapter | undefined;
      return adapter?.getContextCapabilities?.() ?? null;
    },
    getContextEvidenceMode: (instanceId: string) => (
      instanceManager.getInstance(instanceId)?.contextEvidence?.mode ?? 'off'
    ),
    getProviderActionExecutor: (instanceId: string) => {
      const adapter = instanceManager.getAdapter(instanceId) as NativeCompactionAdapter | undefined;
      adapter?.setContextActionProofRecorder?.((action, stage) => {
        coordinator.recordProviderActionProof(instanceId, action, stage);
      });
      const handlers: ConstructorParameters<typeof ProviderContextActionExecutor>[0] = {
        'rebuild-working-set': async () => {
          if (!(await coordinator.compactInstance(instanceId)).success) {
            throw new Error('CONTEXT_REBUILD_PROOF_UNAVAILABLE');
          }
          return { proof: 'observed' };
        },
      };
      if (adapter?.compactContext) {
        handlers['native-compaction'] = async () => {
          if (!await adapter.compactContext!()) {
            throw new Error('NATIVE_COMPACTION_PROOF_UNAVAILABLE');
          }
          return { proof: 'observed' };
        };
      }
      if (adapter?.executeContextAction) {
        const execute = async (action: ProviderContextExecutableAction) => {
          const result = await adapter.executeContextAction!(action);
          if (result.proof === 'none') throw new Error('PROVIDER_ACTION_PROOF_UNAVAILABLE');
          return result;
        };
        handlers['controlled-interrupt'] = () => execute('controlled-interrupt');
        handlers['controlled-recovery'] = () => execute('controlled-recovery');
        handlers['same-thread-continuation'] = () => execute('same-thread-continuation');
      }
      return new ProviderContextActionExecutor(handlers);
    },
    recordPolicyEvent: async (event: ContextPolicyEvent) => {
      const instance = instanceManager.getInstance(event.instanceId);
      const conversationId = instance?.contextEvidence?.conversationId;
      if (!conversationId) return;
      await getConversationLedgerService().recordContextEvidenceEvent({
        conversationId,
        provider: instance.provider,
        eventKind: `context-policy-${event.eventKind}`,
        recoveryEpoch: event.recoveryEpoch,
        thresholdCode: event.thresholdCode ?? null,
        actionCode: event.actionCode ?? null,
        proofStage: event.proofStage ?? null,
        occupancyUsed: event.occupancyUsed ?? null,
        occupancyTotal: event.occupancyTotal ?? null,
        cumulativeTokens: event.cumulativeTokens ?? null,
        outputBytes: event.outputBytes,
        providerRequestCount: event.providerRequestCount,
        newEvidenceCount: event.newEvidenceCount,
        newFindingCount: event.newFindingCount,
        failureCode: event.failureCode ?? null,
        createdAt: event.createdAt,
      });
    },
    nativeCompact: async (instanceId: string, _options?: CompactionBoundaryOptions) => {
      // The adapter's own native compaction has no boundary hook — WS-B7's
      // "keep latest N exchanges" control only applies to the AIO-managed
      // restart-with-summary path below. `previewCompaction()` labels this
      // provider `adapter-self-managed` and says so honestly.
      const adapter = instanceManager.getAdapter(instanceId) as NativeCompactionAdapter | undefined;
      if (!adapter || typeof adapter.compactContext !== 'function') {
        // Honest false. The previous implementation fell through to
        // `sendInput('/compact')` here, but Claude CLI in
        // `--input-format stream-json` mode does not intercept slash
        // commands — `/compact` was forwarded to the model as user text and
        // the model replied with an explanation instead of compacting. With
        // no real hook, returning false lets the coordinator fall through to
        // the restart-with-summary strategy for manual triggers, which
        // performs an actual compaction.
        return false;
      }

      // LT-045: a prior compaction for this same AIO instance already proved
      // the connected provider build never confirms native compaction. That
      // proof was recorded on the coordinator (which survives an adapter
      // respawn) precisely because the adapter's own per-attempt sticky flag
      // (LT-017) does not — restart-with-summary replaces the adapter
      // wholesale, so without this check every single manual compaction paid
      // the full confirmation-timeout wait again, not just the first.
      if (coordinator.isNativeCompactionProvenUnsupported(instanceId)) {
        logger.info('Skipping native compaction — already proven unsupported this session', { instanceId });
        return false;
      }

      try {
        const result = await adapter.compactContext();
        if (!result && adapter.nativeCompactionKnownUnsupported?.()) {
          coordinator.recordNativeCompactionProvenUnsupported(instanceId);
        }
        return result;
      } catch (error) {
        logger.warn('Native compaction strategy failed', {
          instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
    supportsNativeCompaction: (instanceId: string) => {
      const capabilities = instanceManager.getAdapterRuntimeCapabilities(instanceId);
      return capabilities?.supportsNativeCompaction ?? false;
    },
    selfManagesAutoCompaction: (instanceId: string) => {
      const capabilities = instanceManager.getAdapterRuntimeCapabilities(instanceId);
      return capabilities?.selfManagedAutoCompaction === true;
    },
    restartCompact: async (instanceId: string, options?: CompactionBoundaryOptions) => {
      const compactor = ContextCompactor.getInstance();
      try {
        const instance = instanceManager.getInstance(instanceId);
        if (!instance) return false;

        compactor.clear();

        const evidencePreviews = await loadAuthenticatedEvidencePreviews(instance);
        if (evidencePreviews.length > 0) {
          // LT-188: suppress the auto-compact trigger during this bulk rebuild —
          // the explicit `compactor.compact()` call below already handles it
          // deterministically once every turn has been re-added, and letting
          // addTurn's own auto-trigger fire mid-rebuild races that call.
          compactor.addTurn({
            role: 'system',
            content: 'Authenticated evidence is retained below as bounded, untrusted source material.',
            tokenCount: sharedEstimateTokens('Authenticated evidence working set.'),
            toolCalls: evidencePreviews.map((preview) => ({
              id: `evidence-${preview.evidenceId}`,
              name: 'context-evidence',
              input: '[Authenticated ledger lookup]',
              output: preview.preview,
              inputTokens: 5,
              outputTokens: preview.tokenCount + 1,
              evidencePreview: preview,
            })),
          }, { suppressAutoCompact: true });
        }

        const turns = instance.outputBuffer
          .filter(msg => msg.type === 'user' || msg.type === 'assistant')
          .map(msg => ({
            role: msg.type as 'user' | 'assistant',
            content: msg.content,
            tokenCount: sharedEstimateTokens(msg.content),
          }));

        for (const turn of turns) {
          compactor.addTurn(turn, { suppressAutoCompact: true });
        }

        // WS-B7: honor an explicit "keep latest N exchanges" boundary.
        // Omitting it (the pre-WS-B7 default, and what plain "Compact Now"
        // still sends) leaves `compact()` on its own `preserveRecent`
        // config — byte-identical to the prior behavior.
        const preserveRecentOverride = options?.keepLatestExchanges === undefined
          ? undefined
          : exchangesToMessageBoundary(groupExchanges(turns), options.keepLatestExchanges);

        const compactionResult = await compactor.compact(
          preserveRecentOverride === undefined ? undefined : { preserveRecentOverride },
        );
        const summaries = compactor.getState().summaries;
        const latestSummary = summaries[summaries.length - 1];
        const summaryText = latestSummary?.content || 'Previous conversation context was compacted.';

        const latestUserMessage = [...instance.outputBuffer]
          .reverse()
          .find(msg => msg.type === 'user');
        const currentObjective = latestUserMessage?.content || 'Continue from the previous task.';

        const unresolvedItems = instance.outputBuffer
          .slice(-30)
          .flatMap(msg => {
            const matches = msg.content.match(/(?:^|\n)\s*(?:- \[ \]|todo[:-]|next[:-]|follow-up[:-])\s*(.+)/gi) || [];
            return matches.map(m =>
              m.replace(/(?:^|\n)\s*(?:- \[ \]|todo[:-]|next[:-]|follow-up[:-])\s*/i, '').trim()
            );
          })
          .filter(Boolean)
          .slice(0, 5);

        const recentTurns = instance.outputBuffer
          .filter(msg => msg.type === 'user' || msg.type === 'assistant')
          .slice(-8)
          .map(msg => {
            const role = msg.type === 'user' ? 'User' : 'Assistant';
            const content = msg.content.length > 400
              ? `${msg.content.slice(0, 400)}...[truncated]`
              : msg.content;
            return `- ${role}: ${content}`;
          });

        const continuityPrompt = [
          '[Context Compaction Continuity Package]',
          'Compaction method: restart-with-summary',
          '',
          'Objective:',
          currentObjective,
          '',
          'Unresolved items:',
          unresolvedItems.length > 0 ? unresolvedItems.map(item => `- ${item}`).join('\n') : '- None captured.',
          '',
          'Compacted summary:',
          summaryText,
          '',
          'Authenticated evidence working set:',
          evidencePreviews.length > 0
            ? evidencePreviews.map((preview) => preview.preview).join('\n\n')
            : '- No authenticated evidence previews were available.',
          '',
          'Recent turns:',
          recentTurns.length > 0 ? recentTurns.join('\n') : '- No recent turns available.',
          '',
          'Continue from this state without redoing completed work.',
          '[End Continuity Package]',
        ].join('\n');

        // Use a FRESH restart, not the context-preserving one. `restartInstance`
        // recovers via native `--resume` / history replay, which restores the
        // entire prior conversation into the new CLI process — defeating
        // compaction and snapping context usage straight back to ~100%.
        // `restartFreshInstance` spawns a clean session (resume: false, new
        // session id, resetTotalTokensUsed) and archives the old messages, so
        // the continuity package below becomes the seed of an empty context.
        await instanceManager.restartFreshInstance(instanceId);
        await instanceManager.sendInput(
          instanceId,
          continuityPrompt,
          undefined,
          { automatedInput: true },
        );

        logger.info('restart-with-summary compaction completed', {
          instanceId,
          reductionRatio: compactionResult.reductionRatio,
        });

        return true;
      } catch (error) {
        logger.error('Restart-with-summary compaction failed', error instanceof Error ? error : undefined);
        return false;
      } finally {
        compactor.clear();
      }
    },
  });

  coordinator.on('context-warning', (payload) => {
    windowManager.sendToRenderer('context:warning', payload);
  });

  coordinator.on('compaction-started', (payload) => {
    windowManager.sendToRenderer('instance:compact-status', {
      ...payload,
      status: 'started',
    });
  });

  coordinator.on('compaction-completed', (payload) => {
    const { instanceId, result } = payload;
    // WS-B7: consume this instance's pre-compaction checkpoint (if
    // `applyCompaction()` created one) regardless of outcome, so a failed
    // compaction never leaves a stale entry behind.
    const checkpointId = pendingManualCheckpoints.get(instanceId) ?? null;
    pendingManualCheckpoints.delete(instanceId);

    if (result.success) {
      const instance = instanceManager.getInstance(instanceId);
      if (instance) {
        if (!result.newUsage && result.previousUsage) {
          result.newUsage = buildPostCompactionUsage(result.previousUsage);
          instance.contextUsage = result.newUsage;
          instanceManager.updateInstanceStatus(instanceId, instance.status, {
            reason: 'context-compacted',
            method: result.method,
          });
        }

        const markerId = recordCompactionBoundary(instanceId, instance, result);
        const boundaryMessage = {
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          type: 'system' as const,
          content: '— Context compacted —',
          metadata: {
            isCompactionBoundary: true,
            method: result.method,
            previousUsage: result.previousUsage,
            newUsage: result.newUsage,
            ...(markerId ? { compactionMarkerId: markerId } : {}),
            ...(checkpointId ? { checkpointId } : {}),
          },
        };
        instanceManager.emitOutputMessage(instanceId, boundaryMessage);
      }

      void getHookManager().triggerLifecycleHooks('PostCompact', {
        instanceId,
        sessionId: instance?.sessionId,
        workingDirectory: instance?.workingDirectory,
        compactionMethod: result.method,
        compactionSuccess: true,
        previousContextUsage: result.previousUsage?.percentage,
      }).catch((error: unknown) => {
        logger.warn('PostCompact hook dispatch failed', {
          instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    windowManager.sendToRenderer('instance:compact-status', {
      instanceId,
      ...result,
      status: 'completed',
    });
  });

  coordinator.on('compaction-error', (payload) => {
    windowManager.sendToRenderer('instance:compact-status', {
      ...payload,
      status: 'error',
    });
  });
}

/**
 * Manual compaction entry point (WS-B7): creates a labeled pre-compaction
 * checkpoint, then runs the existing compaction path with an optional
 * "keep latest N exchanges" boundary honored. Both the plain "Compact Now"
 * button and the boundary-aware preview dialog's Confirm route through this
 * — the only difference is whether `opts.keepLatestExchanges` is set.
 * Checkpoint creation failures are logged and swallowed; compaction still
 * proceeds (a missing checkpoint should never block manual compaction).
 */
export async function applyCompaction(
  instanceManager: InstanceManager,
  instanceId: string,
  opts?: CompactionBoundaryOptions,
): Promise<CompactionResult> {
  const label = opts?.keepLatestExchanges !== undefined
    ? `Before manual compaction (keep latest ${opts.keepLatestExchanges} exchange${opts.keepLatestExchanges === 1 ? '' : 's'})`
    : 'Before manual compaction';

  let checkpointId: string | null = null;
  try {
    const checkpoint = await getCheckpointManager().createCheckpoint(instanceId, CheckpointType.MANUAL, label);
    checkpointId = checkpoint?.id ?? null;
  } catch (error) {
    logger.warn('Failed to create pre-compaction checkpoint', {
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (checkpointId) pendingManualCheckpoints.set(instanceId, checkpointId);

  try {
    return await getContextEngine().compactInstance(instanceId, opts);
  } finally {
    // Defensive: the `compaction-completed` listener normally consumes this
    // entry synchronously before `compactInstance()` resolves, but an early
    // "already in progress" return never emits that event at all.
    pendingManualCheckpoints.delete(instanceId);
  }
}
