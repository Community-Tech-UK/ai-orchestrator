import { ContextCompactor } from '../context/context-compactor';
import { getCompactionCoordinator, type CompactionResult } from '../context/compaction-coordinator';
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

const logger = getLogger('CompactionRuntime');

interface NativeCompactionAdapter {
  compactContext?: () => Promise<boolean>;
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
