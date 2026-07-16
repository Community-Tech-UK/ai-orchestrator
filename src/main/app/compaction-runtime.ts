import { ContextCompactor } from '../context/context-compactor';
import {
  getCompactionCoordinator,
  type CompactionResult,
  type ContextPolicyEvent,
} from '../context/compaction-coordinator';
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
import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import type { ContextUsage, Instance } from '../../shared/types/instance.types';
import { getConversationLedgerService } from '../conversation-ledger';
import { getContextEvidenceRuntime } from '../context-evidence/evidence-maintenance-service';
import {
  EvidencePreviewBuilder,
  type VerifiedEvidencePreview,
} from '../context-evidence/evidence-preview-builder';
import {
  ProviderContextActionExecutor,
  type ProviderContextActionHandlerResult,
  type ProviderContextExecutableAction,
} from '../context-evidence/provider-context-action-executor';

const logger = getLogger('CompactionRuntime');

interface NativeCompactionAdapter {
  compactContext?: () => Promise<boolean>;
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
    nativeCompact: async (instanceId: string) => {
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

      try {
        return await adapter.compactContext();
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
    restartCompact: async (instanceId: string) => {
      const compactor = ContextCompactor.getInstance();
      try {
        const instance = instanceManager.getInstance(instanceId);
        if (!instance) return false;

        compactor.clear();

        const evidencePreviews = await loadAuthenticatedEvidencePreviews(instance);
        if (evidencePreviews.length > 0) {
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
          });
        }

        const turns = instance.outputBuffer
          .filter(msg => msg.type === 'user' || msg.type === 'assistant')
          .map(msg => ({
            role: msg.type as 'user' | 'assistant',
            content: msg.content,
            tokenCount: sharedEstimateTokens(msg.content),
          }));

        for (const turn of turns) {
          compactor.addTurn(turn);
        }

        const compactionResult = await compactor.compact();
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
        await instanceManager.sendInput(instanceId, continuityPrompt);

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

async function loadAuthenticatedEvidencePreviews(
  instance: Instance,
): Promise<VerifiedEvidencePreview[]> {
  const conversationId = instance.contextEvidence?.conversationId;
  if (!conversationId) return [];
  try {
    const runtime = getContextEvidenceRuntime();
    const records = await getConversationLedgerService().listEvidence(conversationId, { limit: 25 });
    const builder = new EvidencePreviewBuilder(runtime.blobStore);
    const previews: VerifiedEvidencePreview[] = [];
    for (const record of records) {
      const result = await builder.build(record);
      if (result.canReplaceOriginal) previews.push(result.preview);
    }
    return previews;
  } catch (error) {
    logger.warn('Authenticated evidence previews unavailable for restart compaction', {
      instanceId: instance.id,
      errorCode: evidencePreviewFailureCode(error),
    });
    return [];
  }
}

function evidencePreviewFailureCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : 'EVIDENCE_PREVIEW_UNAVAILABLE';
}
