import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { ChildDiagnosticBundle } from '../../shared/types/agent-tree.types';
import { buildChildDiagnosticBundle } from '../orchestration/child-diagnostics';
import { getChildResultStorage } from '../orchestration/child-result-storage';
import { getTaskManager } from '../orchestration/task-manager';
import { emitPluginHook } from '../plugins/hook-emitter';
import { getLogger } from '../logging/logger';

const logger = getLogger('InstanceChildCompletion');

interface ChildSummaryData {
  resultId: string;
  summary: string;
  success: boolean;
  conclusions: string[];
  artifactCount: number;
}

interface ChildCompletionOrchestration {
  notifyChildTerminated(
    parentId: string,
    childId: string,
    resultData?: {
      name: string;
      summary: string;
      success: boolean;
      conclusions: string[];
    },
  ): { remainingChildren: number };
  getCompletedChildIds(parentId: string): string[];
  notifyAllChildrenCompleted(
    parentId: string,
    summaries: Array<{
      childId: string;
      name: string;
      summary: string;
      success: boolean;
      conclusions: string[];
    }>,
  ): void;
}

interface ChildCompletionTaskManager {
  getTaskByChildId(childId: string): { task?: string } | null | undefined;
  cleanupChildTasks(childId: string): void;
}

interface ChildCompletionStorage {
  hasResult(childId: string): boolean;
  storeFromOutputBuffer(
    childId: string,
    parentId: string,
    task: string,
    summary: string,
    success: boolean,
    outputBuffer: OutputMessage[],
    createdAt: number,
  ): Promise<unknown>;
  getChildSummary(childId: string): Promise<{
    childId?: string;
    resultId: string;
    summary: string;
    success: boolean;
    conclusions: string[];
    artifactCount: number;
  } | null>;
}

export interface InstanceChildCompletionDeps {
  getInstance: (id: string) => Instance | undefined;
  addToOutputBuffer: (instance: Instance, message: OutputMessage) => void;
  publishOutput: (instanceId: string, message: OutputMessage) => void;
  terminateInstance: (instanceId: string, graceful: boolean) => Promise<void>;
  getOrchestrationHandler: () => ChildCompletionOrchestration;
  taskManager?: ChildCompletionTaskManager;
  storage?: ChildCompletionStorage;
  buildDiagnosticBundle?: (child: Instance, timeoutReason?: string) => Promise<ChildDiagnosticBundle>;
}

export class InstanceChildCompletionHandler {
  private readonly completedChildNotifications = new Set<string>();

  constructor(private readonly deps: InstanceChildCompletionDeps) {}

  async handleChildExit(childId: string, child: Instance, exitCode: number | null): Promise<void> {
    if (!child.parentId) return;
    if (this.completedChildNotifications.has(childId)) {
      logger.debug('Ignoring duplicate child completion notification', {
        childId,
        parentId: child.parentId,
        exitCode,
      });
      return;
    }
    this.completedChildNotifications.add(childId);

    const orchestration = this.deps.getOrchestrationHandler();
    const taskManager = this.deps.taskManager ?? getTaskManager();
    const storage = this.deps.storage ?? getChildResultStorage();

    if (!storage.hasResult(childId)) {
      const task = taskManager.getTaskByChildId(childId);
      const summary = this.buildFallbackSummary(child, exitCode);

      try {
        await storage.storeFromOutputBuffer(
          childId,
          child.parentId,
          task?.task || child.displayName,
          summary.summary,
          summary.success,
          child.outputBuffer,
          child.createdAt
        );
      } catch (err) {
        logger.error('Failed to auto-capture result for child', err instanceof Error ? err : undefined, { childId });
      }
    }

    const childSummaryData = await this.getChildSummaryData(storage, childId);
    this.addParentNotification(child, childId, exitCode, childSummaryData);

    taskManager.cleanupChildTasks(childId);

    const resultData = childSummaryData
      ? {
          name: child.displayName,
          summary: childSummaryData.summary,
          success: childSummaryData.success,
          conclusions: childSummaryData.conclusions,
        }
      : undefined;

    const { remainingChildren } = orchestration.notifyChildTerminated(
      child.parentId,
      childId,
      resultData
    );

    logger.info('Child exited, parent notified', { childId, exitCode, parentId: child.parentId, remainingChildren });
    await this.emitCompletionHook(child, childId, exitCode, childSummaryData);

    if (remainingChildren === 0) {
      await this.finishAllCompletedChildren(child, orchestration, storage);
    } else {
      await this.terminateChild(childId);
    }
  }

  private buildFallbackSummary(child: Instance, exitCode: number | null): { summary: string; success: boolean } {
    const isOwn = (m: { metadata?: Record<string, unknown> }): boolean =>
      !m.metadata?.['seededFromParent'];
    const lastAssistant = [...child.outputBuffer]
      .reverse()
      .find((m) => m.type === 'assistant' && isOwn(m));
    const lastError = lastAssistant
      ? undefined
      : [...child.outputBuffer]
          .reverse()
          .find((m) => m.type === 'error' && isOwn(m));
    const summary = lastAssistant
      ? lastAssistant.content.substring(0, 500)
      : lastError
        ? `Child errored before producing a reply: ${lastError.content.substring(0, 500)}`
        : 'Child exited without producing any output.';

    return {
      summary,
      success: exitCode === 0 && lastAssistant !== undefined,
    };
  }

  private async getChildSummaryData(
    storage: ChildCompletionStorage,
    childId: string,
  ): Promise<ChildSummaryData | undefined> {
    try {
      const childSummary = await storage.getChildSummary(childId);
      if (!childSummary) {
        return undefined;
      }
      return {
        resultId: childSummary.resultId,
        summary: childSummary.summary,
        success: childSummary.success,
        conclusions: childSummary.conclusions,
        artifactCount: childSummary.artifactCount,
      };
    } catch (err) {
      logger.error('Failed to get child summary', err instanceof Error ? err : undefined, { childId });
      return undefined;
    }
  }

  private addParentNotification(
    child: Instance,
    childId: string,
    exitCode: number | null,
    childSummaryData: ChildSummaryData | undefined,
  ): void {
    const parent = child.parentId ? this.deps.getInstance(child.parentId) : undefined;
    if (!parent) {
      return;
    }

    let resultContent = `**Child completed:** ${child.displayName} (\`${childId}\`)`;
    if (childSummaryData) {
      resultContent += `\n\n**Result:** ${childSummaryData.success ? 'Success' : 'Failed'}`;
      resultContent += `\n\n${childSummaryData.summary}`;
      if (childSummaryData.conclusions.length > 0) {
        resultContent += `\n\n**Key findings:**\n${childSummaryData.conclusions.map(c => `- ${c}`).join('\n')}`;
      }
    }

    const resultMessage: OutputMessage = {
      id: `child-result-${Date.now()}-${childId.slice(-6)}`,
      timestamp: Date.now(),
      type: 'system',
      content: resultContent,
      metadata: { source: 'child-result', childId, exitCode },
    };
    this.deps.addToOutputBuffer(parent, resultMessage);
    this.deps.publishOutput(child.parentId!, resultMessage);
  }

  private async emitCompletionHook(
    child: Instance,
    childId: string,
    exitCode: number | null,
    childSummaryData: ChildSummaryData | undefined,
  ): Promise<void> {
    if (!child.parentId) {
      return;
    }

    const childFailed = childSummaryData?.success === false || exitCode !== 0;
    const buildDiagnostic =
      this.deps.buildDiagnosticBundle ??
      ((target, reason) => buildChildDiagnosticBundle(target, reason));
    const diagnosticBundle = childFailed
      ? await buildDiagnostic(child, this.getChildTimeoutReason(child)).catch((error: unknown) => {
          logger.warn('Failed to build child diagnostic bundle', {
            childId,
            parentId: child.parentId,
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        })
      : undefined;
    emitPluginHook(childFailed ? 'orchestration.child.failed' : 'orchestration.child.completed', {
      parentId: child.parentId,
      childId,
      name: child.displayName,
      success: childSummaryData?.success,
      summary: childSummaryData?.summary,
      resultId: childSummaryData?.resultId,
      exitCode,
      diagnosticBundle,
      timestamp: Date.now(),
    });
  }

  private async finishAllCompletedChildren(
    child: Instance,
    orchestration: ChildCompletionOrchestration,
    storage: ChildCompletionStorage,
  ): Promise<void> {
    if (!child.parentId) {
      return;
    }

    const completedIds = orchestration.getCompletedChildIds(child.parentId);
    const summaries = await Promise.all(
      completedIds.map(async (cId) => {
        try {
          const s = await storage.getChildSummary(cId);
          const inst = this.deps.getInstance(cId);
          return {
            childId: cId,
            name: inst?.displayName || s?.childId || cId,
            summary: s?.summary || 'No summary available',
            success: s?.success ?? false,
            conclusions: s?.conclusions || [],
          };
        } catch {
          return {
            childId: cId,
            name: cId,
            summary: 'Failed to retrieve summary',
            success: false,
            conclusions: [],
          };
        }
      })
    );

    if (summaries.length > 0) {
      orchestration.notifyAllChildrenCompleted(child.parentId, summaries);
      logger.info('All children completed, synthesis prompt injected', { parentId: child.parentId, childCount: summaries.length });
    }

    for (const cId of completedIds) {
      await this.terminateChild(cId);
    }
  }

  private async terminateChild(childId: string): Promise<void> {
    try {
      await this.deps.terminateInstance(childId, false);
    } catch (err) {
      logger.error('Failed to clean up child instance', err instanceof Error ? err : undefined, { childId });
    }
  }

  private getChildTimeoutReason(child: Instance): string | undefined {
    const timeoutMessage = [...child.outputBuffer]
      .reverse()
      .find((message) => (
        message.metadata?.['source'] === 'child-startup-watchdog'
        && typeof message.content === 'string'
      ));
    return timeoutMessage?.content;
  }
}
