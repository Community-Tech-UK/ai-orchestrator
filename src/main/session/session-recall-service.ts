import type { AutomationStore } from '../automations/automation-store';
import { getAutomationStore } from '../automations';
import { getChildResultStorage } from '../orchestration/child-result-storage';
import type { SessionRecallQuery, SessionRecallResult } from '../../shared/types/session-recall.types';
import { AgentTreePersistence } from './agent-tree-persistence';

function scoreText(queryTerms: string[], text: string): number {
  const haystack = text.toLowerCase();
  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

export class SessionRecallService {
  constructor(
    private readonly automationStore: AutomationStore = getAutomationStore(),
    private readonly treePersistence = AgentTreePersistence.getInstance(),
  ) {}

  async search(query: SessionRecallQuery): Promise<SessionRecallResult[]> {
    const terms = query.query.toLowerCase().split(/\s+/).filter(Boolean);
    const limit = query.limit ?? 20;
    const results: SessionRecallResult[] = [];

    if (query.parentId) {
      const childResults = await getChildResultStorage().getResultsForParent(query.parentId);
      for (const result of childResults) {
        const text = `${result.taskDescription} ${result.summary} ${result.conclusions.join(' ')}`;
        const score = scoreText(terms, text);
        if (score > 0 || terms.length === 0) {
          results.push({
            source: 'child_result',
            id: result.id,
            title: result.taskDescription,
            summary: result.summary,
            score,
            timestamp: result.completedAt,
            metadata: {
              childId: result.childId,
              parentId: result.parentId,
              artifactCount: result.artifactCount,
            },
          });
        }
      }
    }

    for (const run of this.automationStore.listRuns({ automationId: query.automationId, limit: 200 })) {
      const text = `${run.configSnapshot?.name ?? ''} ${run.outputSummary ?? ''} ${run.error ?? ''}`;
      const score = scoreText(terms, text);
      if (score > 0 || terms.length === 0) {
        results.push({
          source: 'automation_run',
          id: run.id,
          title: run.configSnapshot?.name ?? run.automationId,
          summary: run.outputSummary ?? run.error ?? run.status,
          score,
          timestamp: run.finishedAt ?? run.startedAt ?? run.createdAt,
          metadata: {
            automationId: run.automationId,
            trigger: run.trigger,
            outputFullRef: run.outputFullRef,
          },
        });
      }
    }

    for (const snapshot of await this.treePersistence.listSnapshots()) {
      const text = `${snapshot.id} ${snapshot.rootId}`;
      const score = scoreText(terms, text);
      if (score > 0 || terms.length === 0) {
        results.push({
          source: 'agent_tree',
          id: snapshot.id,
          title: `Agent tree ${snapshot.rootId}`,
          summary: `${snapshot.totalInstances} instance(s)`,
          score,
          timestamp: snapshot.timestamp,
          metadata: { rootId: snapshot.rootId },
        });
      }
    }

    return results
      .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
      .slice(0, limit);
  }
}

let sessionRecallService: SessionRecallService | null = null;

export function getSessionRecallService(): SessionRecallService {
  if (!sessionRecallService) {
    sessionRecallService = new SessionRecallService();
  }
  return sessionRecallService;
}

export function _resetSessionRecallServiceForTesting(): void {
  sessionRecallService = null;
}
