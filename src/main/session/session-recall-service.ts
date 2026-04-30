import type { AutomationStore } from '../automations/automation-store';
import { getAutomationStore } from '../automations';
import { getChildResultStorage } from '../orchestration/child-result-storage';
import type { ChildResultStorage } from '../orchestration/child-result-storage';
import type { ChildResult } from '../../shared/types/child-result.types';
import type {
  SessionRecallQuery,
  SessionRecallResult,
  SessionRecallSource,
} from '../../shared/types/session-recall.types';
import { AgentTreePersistence } from './agent-tree-persistence';
import type { AgentTreeNode } from '../../shared/types/agent-tree.types';
import { getSessionArchiveManager, type SessionArchiveManager } from './session-archive';
import { getHistoryManager, type HistoryManager } from '../history/history-manager';
import {
  projectMemoryKeysEqual,
  projectMemoryPathContains,
} from '../memory/project-memory-key';

function scoreText(queryTerms: string[], text: string): number {
  const haystack = text.toLowerCase();
  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function hasFailureStatus(status: string): boolean {
  return ['error', 'failed', 'terminated', 'cancelled', 'superseded'].includes(status);
}

function compact(value: string, max = 700): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

export class SessionRecallService {
  constructor(
    private readonly automationStore: AutomationStore = getAutomationStore(),
    private readonly treePersistence = AgentTreePersistence.getInstance(),
    private readonly childResultStorage: ChildResultStorage = getChildResultStorage(),
    private readonly archiveManagerProvider: () => SessionArchiveManager = getSessionArchiveManager,
    private readonly historyProvider: () => HistoryManager = getHistoryManager,
  ) {}

  async search(query: SessionRecallQuery): Promise<SessionRecallResult[]> {
    const terms = query.query.toLowerCase().split(/\s+/).filter(Boolean);
    const limit = query.limit ?? 20;
    const results: SessionRecallResult[] = [];
    const sourceFilter = query.sources ? new Set<SessionRecallSource>(query.sources) : undefined;
    const intent = query.intent ?? 'general';
    const includeSource = (source: SessionRecallSource): boolean => !sourceFilter || sourceFilter.has(source);

    if (includeSource('child_result') && intent !== 'automationRunHistory' && intent !== 'stuckSessionDiagnostics') {
      const childResults = query.parentId
        ? await this.childResultStorage.getResultsForParent(query.parentId)
        : await this.childResultStorage.getAllResults(200);
      for (const result of childResults) {
        if (!this.childResultMatchesIntent(result, query)) {
          continue;
        }
        const text = `${result.taskDescription} ${result.summary} ${result.conclusions.join(' ')} ${result.keyDecisions.join(' ')}`;
        const score = scoreText(terms, text);
        if (score > 0 || terms.length === 0) {
          results.push({
            source: 'child_result',
            id: result.id,
            title: result.taskDescription,
            summary: compact(result.summary),
            score,
            timestamp: result.completedAt,
            sourceLink: {
              type: 'child_result',
              ref: result.id,
              label: 'Open child result summary',
            },
            hasMore: result.artifactCount > 0 || result.fullTranscriptTokens > 0,
            metadata: {
              childId: result.childId,
              parentId: result.parentId,
              artifactCount: result.artifactCount,
              success: result.success,
            },
          });
        }
      }
    }

    if (includeSource('automation_run') && intent !== 'priorDecisions' && intent !== 'stuckSessionDiagnostics') {
      for (const run of this.automationStore.listRuns({ automationId: query.automationId, limit: 200 })) {
        if (!this.automationRunMatchesIntent(run, query)) {
          continue;
        }
        const text = `${run.configSnapshot?.name ?? ''} ${run.outputSummary ?? ''} ${run.error ?? ''}`;
        const score = scoreText(terms, text);
        if (score > 0 || terms.length === 0) {
          results.push({
            source: 'automation_run',
            id: run.id,
            title: run.configSnapshot?.name ?? run.automationId,
            summary: compact(run.outputSummary ?? run.error ?? run.status),
            score,
            timestamp: run.finishedAt ?? run.startedAt ?? run.createdAt,
            sourceLink: {
              type: 'automation_run',
              ref: run.id,
              label: 'Open automation run',
            },
            hasMore: Boolean(run.outputFullRef),
            metadata: {
              automationId: run.automationId,
              trigger: run.trigger,
              outputFullRef: run.outputFullRef,
              provider: run.configSnapshot?.action.provider,
              model: run.configSnapshot?.action.model,
              workingDirectory: run.configSnapshot?.action.workingDirectory,
            },
          });
        }
      }
    }

    const snapshots = await this.treePersistence.listSnapshots();
    if (includeSource('child_diagnostic') && intent !== 'automationRunHistory' && intent !== 'priorDecisions') {
      for (const meta of snapshots.slice(0, 100)) {
        const snapshot = await this.treePersistence.loadSnapshot(meta.id);
        if (!snapshot) {
          continue;
        }
        for (const node of snapshot.nodes) {
          if (!node.parentId || !this.nodeMatchesQuery(node, query)) {
            continue;
          }
          const text = [
            node.displayName,
            node.status,
            node.provider,
            node.model,
            node.workingDirectory,
            node.spawnConfig?.task,
            node.routing?.reason,
          ].filter(Boolean).join(' ');
          const score = scoreText(terms, text);
          if (score > 0 || terms.length === 0) {
            results.push({
              source: 'child_diagnostic',
              id: `${meta.id}:${node.instanceId}`,
              title: `Child ${node.displayName}`,
              summary: compact(`${node.status}${node.routing?.reason ? `: ${node.routing.reason}` : ''}`),
              score,
              timestamp: node.lastActivityAt,
              sourceLink: {
                type: 'agent_tree_snapshot',
                ref: meta.id,
                label: 'Open agent tree snapshot',
              },
              hasMore: Boolean(node.resultId),
              metadata: {
                snapshotId: meta.id,
                childId: node.instanceId,
                parentId: node.parentId,
                provider: node.provider,
                model: node.model,
                workingDirectory: node.workingDirectory,
                statusTimeline: node.statusTimeline,
                resultId: node.resultId,
                artifactCount: node.artifactCount,
              },
            });
          }
        }
      }
    }

    if (includeSource('agent_tree') && intent === 'general') {
      for (const snapshot of snapshots) {
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
            sourceLink: {
              type: 'agent_tree_snapshot',
              ref: snapshot.id,
              label: 'Open agent tree snapshot',
            },
            metadata: { rootId: snapshot.rootId },
          });
        }
      }
    }

    if (includeSource('archived_session') && intent !== 'automationRunHistory' && intent !== 'stuckSessionDiagnostics') {
      try {
        const archiveManager = this.archiveManagerProvider();
        const archives = archiveManager.listArchivedSessions({
          searchTerm: query.query.trim() || query.repositoryPath,
        });
        for (const archive of archives.slice(0, 100)) {
          if (query.repositoryPath && !projectMemoryKeysEqual(archive.workingDirectory, query.repositoryPath)) {
            continue;
          }
          const text = `${archive.displayName} ${archive.workingDirectory} ${(archive.tags ?? []).join(' ')}`;
          const score = scoreText(terms, text);
          if (score > 0 || terms.length === 0) {
            results.push({
              source: 'archived_session',
              id: archive.id,
              title: archive.displayName,
              summary: compact(`${archive.messageCount} message(s) in ${archive.workingDirectory}`),
              score,
              timestamp: archive.archivedAt,
              sourceLink: {
                type: 'archived_session',
                ref: archive.id,
                label: 'Open archived session',
              },
              hasMore: archive.messageCount > 0,
              metadata: {
                workingDirectory: archive.workingDirectory,
                tags: archive.tags,
                lastActivity: archive.lastActivity,
                totalTokensUsed: archive.totalTokensUsed,
              },
            });
          }
        }
      } catch {
        // Archive recall is best-effort because early startup/tests may not have Electron app paths.
      }
    }

    if (
      includeSource('history-transcript') &&
      query.includeHistoryTranscripts === true &&
      intent !== 'automationRunHistory' &&
      intent !== 'stuckSessionDiagnostics'
    ) {
      const cap = Math.max(0, query.maxHistoryTranscriptResults ?? 25);
      const historyEntries = this.historyProvider().getEntries({
        snippetQuery: query.query.trim() || undefined,
        workingDirectory: query.repositoryPath,
        projectScope: query.repositoryPath ? 'current' : 'all',
        source: 'history-transcript',
      });
      let added = 0;
      const loweredQuery = query.query.toLowerCase();

      for (const entry of historyEntries) {
        if (added >= cap) {
          break;
        }
        if (query.repositoryPath && !projectMemoryKeysEqual(entry.workingDirectory, query.repositoryPath)) {
          continue;
        }

        const snippets = (entry.snippets ?? []).filter(snippet =>
          !loweredQuery || snippet.excerpt.toLowerCase().includes(loweredQuery)
        );
        for (const snippet of snippets) {
          if (added >= cap) {
            break;
          }

          results.push({
            source: 'history-transcript',
            id: `${entry.id}:${snippet.position}`,
            title: entry.displayName,
            summary: compact(snippet.excerpt),
            score: snippet.score + scoreText(terms, entry.displayName) * 0.1,
            timestamp: entry.endedAt,
            sourceLink: {
              type: 'archived_session',
              ref: entry.id,
              label: 'Open archived session',
            },
            hasMore: (entry.snippets?.length ?? 0) > snippets.length,
            metadata: {
              entryId: entry.id,
              position: snippet.position,
              excerpt: snippet.excerpt,
              provider: entry.provider,
              model: entry.currentModel,
              workingDirectory: entry.workingDirectory,
              historyThreadId: entry.historyThreadId,
            },
          });
          added += 1;
        }
      }
    }

    return results
      .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async getSessionDiagnostics(sessionId: string): Promise<{
    sessionId: string;
    generatedAt: number;
    results: SessionRecallResult[];
  }> {
    const results = await this.search({
      query: sessionId,
      limit: 50,
      includeHistoryTranscripts: false,
    });
    return {
      sessionId,
      generatedAt: Date.now(),
      results,
    };
  }

  private childResultMatchesIntent(result: ChildResult, query: SessionRecallQuery): boolean {
    switch (query.intent) {
      case 'priorFailuresByProviderModel':
        return result.success === false;
      case 'priorFixesByRepositoryPath':
        return !query.repositoryPath || result.artifacts.some((artifact) =>
          projectMemoryPathContains(artifact.file, query.repositoryPath!)
        );
      case 'priorDecisions':
        return result.keyDecisions.length > 0 || result.conclusions.length > 0;
      case 'automationRunHistory':
      case 'stuckSessionDiagnostics':
        return false;
      case 'general':
      case undefined:
        return true;
    }
  }

  private automationRunMatchesIntent(
    run: ReturnType<AutomationStore['listRuns']>[number],
    query: SessionRecallQuery,
  ): boolean {
    if (query.provider && run.configSnapshot?.action.provider !== query.provider) {
      return false;
    }
    if (query.model && run.configSnapshot?.action.model !== query.model) {
      return false;
    }
    if (
      query.repositoryPath
      && !projectMemoryKeysEqual(run.configSnapshot?.action.workingDirectory, query.repositoryPath)
    ) {
      return false;
    }
    switch (query.intent) {
      case 'priorFailuresByProviderModel':
        return run.status === 'failed';
      case 'priorFixesByRepositoryPath':
        return Boolean(run.outputSummary || run.outputFullRef);
      case 'automationRunHistory':
        return true;
      case 'general':
      case undefined:
        return true;
      case 'priorDecisions':
      case 'stuckSessionDiagnostics':
        return false;
    }
  }

  private nodeMatchesQuery(node: AgentTreeNode, query: SessionRecallQuery): boolean {
    if (query.parentId && node.parentId !== query.parentId) {
      return false;
    }
    if (query.provider && node.provider !== query.provider) {
      return false;
    }
    if (query.model && node.model !== query.model) {
      return false;
    }
    if (query.repositoryPath && !projectMemoryKeysEqual(node.workingDirectory, query.repositoryPath)) {
      return false;
    }
    switch (query.intent) {
      case 'priorFailuresByProviderModel':
        return hasFailureStatus(node.status);
      case 'stuckSessionDiagnostics':
        return hasFailureStatus(node.status) || node.status === 'waiting_for_input' || node.status === 'waiting_for_permission';
      case 'priorFixesByRepositoryPath':
      case 'general':
      case undefined:
        return true;
      case 'priorDecisions':
      case 'automationRunHistory':
        return false;
    }
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
