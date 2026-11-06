import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../../../shared/types/instance.types';
import type { CliResponse } from '../base-cli-adapter';
import type { AppServerNotification } from './app-server-types';
import { _resetCostAttributionForTesting } from '../../../core/system/cost-attribution';
import { CostPurposeSummaryService, getCostPurposeSummary } from '../../../core/system/cost-purpose-summary';
import { recordCompletionCost } from '../../../instance/communication-completion-cost';
import { InstanceCompleteParamsSchema } from '../../../remote-node/rpc-schemas';

vi.mock('../../../core/system/cost-tracker', () => ({ getCostTracker: () => ({ recordUsage: () => ({ cost: 0 }) }) }));
vi.mock('../../../context/cache-analytics-service', () => ({ getCacheAnalyticsService: () => ({ recordTurn: () => undefined }) }));
vi.mock('./child-rollout-usage', () => ({ readChildRolloutUsage: async () => [] }));
import { CodexCliAdapter } from '../codex-cli-adapter';

describe('native Codex turn identity reaches cost attribution', () => {
  const directories: string[] = [];
  afterEach(() => {
    CostPurposeSummaryService._resetForTesting();
    _resetCostAttributionForTesting();
    vi.unstubAllEnvs();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('carries both native ids through completed response, remote wire, cost writer and summary', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-cost-identity-'));
    directories.push(directory);
    vi.stubEnv('AIO_COST_ATTRIBUTION_DIR', join(directory, 'cost'));
    vi.stubEnv('AIO_SESSION_POLICY_DIR', join(directory, 'policy'));
    vi.stubEnv('AIO_COST_ATTRIBUTION', '1');
    _resetCostAttributionForTesting();
    const adapter = new CodexCliAdapter({ instanceId: 'instance', model: 'gpt-6-astra', sessionKind: 'chat' });
    const subscribers = new Set<(notification: AppServerNotification) => void>();
    let turns = 0;
    const emit = (notification: AppServerNotification) => { for (const listener of [...subscribers]) listener(notification); };
    const client = {
      exitPromise: new Promise<void>(() => { /* No provider process. */ }),
      subscribeNotifications(listener: (notification: AppServerNotification) => void) {
        subscribers.add(listener);
        return () => { subscribers.delete(listener); };
      },
      async request(method: string) {
        if (method !== 'turn/start') return {};
        const turnId = `turn-${++turns}`;
        emit({ method: 'turn/started', params: { threadId: 'root', turn: { id: turnId } } });
        emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'root', turnId,
          tokenUsage: { total: { inputTokens: turns * 100, totalTokens: turns * 100 }, last: { inputTokens: 100, totalTokens: 100 } } } });
        emit({ method: 'turn/completed', params: { threadId: 'root', turn: { id: turnId, status: 'completed' } } });
        return { turn: { id: turnId, status: 'completed' } };
      },
    };
    Object.assign(adapter, { appServerClient: client, appServerThreadId: 'root', useAppServer: true, isSpawned: true });
    const responses: CliResponse[] = [];
    const instance = { id: 'instance', sessionId: 'logical-session', provider: 'codex', currentModel: 'gpt-6-astra', parentId: null,
      agentId: 'build', metadata: {}, contextUsage: {} } as unknown as Instance;
    adapter.on('complete', (response: CliResponse) => {
      // Same schema and serialized payload the remote worker transports.
      const wire = InstanceCompleteParamsSchema.parse(JSON.parse(JSON.stringify({ instanceId: 'instance', response })));
      responses.push(wire.response as CliResponse);
      recordCompletionCost(instance.id, instance, wire.response as CliResponse);
    });
    try {
      const send = () => (adapter as unknown as { appServerSendMessageInner(text: string): Promise<void> }).appServerSendMessageInner('work');
      await send();
      await send();
      expect(responses.map(response => response.metadata?.['codexTurn'])).toEqual([
        { threadId: 'root', turnId: 'turn-1' }, { threadId: 'root', turnId: 'turn-2' },
      ]);
      const summary = getCostPurposeSummary().getSummary();
      expect(summary.totals.calls).toBe(2);
      expect(summary.biggestTurns?.map(row => [row.source, row.processedTokens])).toEqual([['codex-round', 100], ['codex-round', 100]]);
      expect(subscribers.size).toBe(0);
    } finally {
      await adapter.terminate(false);
    }
  });
});
