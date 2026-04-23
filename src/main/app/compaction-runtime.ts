import { ContextCompactor } from '../context/context-compactor';
import { getCompactionCoordinator } from '../context/compaction-coordinator';
import { getLogger } from '../logging/logger';
import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';

const logger = getLogger('CompactionRuntime');

export function setupCompactionCoordinator(
  instanceManager: InstanceManager,
  windowManager: WindowManager,
): void {
  const coordinator = getCompactionCoordinator();

  coordinator.configure({
    nativeCompact: async (instanceId: string) => {
      try {
        await instanceManager.sendInput(instanceId, '/compact');
        return true;
      } catch {
        return false;
      }
    },
    supportsNativeCompaction: (instanceId: string) => {
      const capabilities = instanceManager.getAdapterRuntimeCapabilities(instanceId);
      return capabilities?.supportsNativeCompaction ?? false;
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
            tokenCount: Math.ceil(msg.content.length / 4),
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

        await instanceManager.restartInstance(instanceId);
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
    windowManager.sendToRenderer('instance:compact-status', {
      instanceId,
      ...result,
      status: 'completed',
    });

    if (result.success) {
      const instance = instanceManager.getInstance(instanceId);
      if (instance) {
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
          },
        };
        instanceManager.emitOutputMessage(instanceId, boundaryMessage);
      }
    }
  });

  coordinator.on('compaction-error', (payload) => {
    windowManager.sendToRenderer('instance:compact-status', {
      ...payload,
      status: 'error',
    });
  });
}
