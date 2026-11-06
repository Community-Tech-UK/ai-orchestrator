import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { ChildDiagnosticBundle } from '../../shared/types/agent-tree.types';
import { buildChildDiagnosticBundle } from '../orchestration/child-diagnostics';
import { ChildCompletionBatcher, type ChildCompletionResultData } from '../orchestration/child-completion-batcher';
import { getChildResultStorage } from '../orchestration/child-result-storage';
import { getTaskManager } from '../orchestration/task-manager';
import { emitPluginHook } from '../plugins/hook-emitter';
import { getLogger } from '../logging/logger';
import { ownedByEngine } from '../work-admission/engine-ownership';
import { recordSessionPolicy } from '../core/system/session-policy-log';
import { errorMessageText } from '../util/error-utils';

const logger = getLogger('InstanceChildCompletion');

interface ChildSummaryData {
  resultId: string;
  summary: string;
  success: boolean;
  conclusions: string[];
  artifactCount: number;
}

interface ChildCompletionOrchestration {
  on?(event: 'child-spawned', listener: (parentId: string, childId: string) => void): unknown;
  removeListener?(event: 'child-spawned', listener: (parentId: string, childId: string) => void): unknown;
  notifyChildTerminated(
    parentId: string,
    childId: string,
    resultData?: ChildCompletionResultData,
    options?: { deliver?: boolean },
  ): { remainingChildren: number };
  deliverChildCompleted(parentId: string, childId: string, resultData?: ChildCompletionResultData): void;
  getCompletedChildIds(parentId: string): string[];
  getActiveChildCount(parentId: string): number;
  notifyAllChildrenCompleted(
    parentId: string,
    summaries: Array<{
      childId: string;
      name: string;
      summary: string;
      success: boolean;
      conclusions: string[];
    }>,
    options?: { othersStillRunning?: boolean },
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
  batcher?: ChildCompletionBatcher;
}

export class InstanceChildCompletionHandler {
  private readonly completedChildNotifications = new Set<string>();
  private readonly batcher: ChildCompletionBatcher;
  private readonly orchestration: ChildCompletionOrchestration;
  // Weak identity fencing also covers removal's synchronous emit-before-delete edge.
  private readonly removedParents = new WeakSet<Instance>();
  private disposed = false;
  private readonly onChildSpawned = (parentId: string, childId: string): void => {
    this.noteSpawn(parentId, childId);
  };

  constructor(private readonly deps: InstanceChildCompletionDeps) {
    this.orchestration = deps.getOrchestrationHandler();
    this.batcher = deps.batcher ?? new ChildCompletionBatcher((parentId, childId, resultData) => {
      if (!this.isParentCurrent(parentId, this.deps.getInstance(parentId))) return;
      this.orchestration.deliverChildCompleted(parentId, childId, resultData);
      this.batcher.markReported(parentId, childId);
    });
    this.orchestration.on?.('child-spawned', this.onChildSpawned);
  }

  noteSpawn(parentId: string, childId: string, now: number = Date.now()): void {
    if (this.isParentCurrent(parentId, this.deps.getInstance(parentId))) this.batcher.noteSpawn(parentId, childId, now);
  }

  removeParent(parentId: string): void {
    const parent = this.deps.getInstance(parentId);
    if (parent) this.removedParents.add(parent);
    this.batcher.removeParent(parentId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.orchestration.removeListener?.('child-spawned', this.onChildSpawned);
    this.batcher.dispose();
  }

  private isParentCurrent(parentId: string, parent: Instance | undefined): boolean {
    return !this.disposed && parent !== undefined && !this.removedParents.has(parent)
      && this.deps.getInstance(parentId) === parent;
  }

  async handleChildExit(childId: string, child: Instance, exitCode: number | null): Promise<void> {
    // Engine sessions (Plan Queue workers and checkers, loops, automations) can sit
    // under a parent, but their engine owns their lifetime: a finished turn is not
    // a finished helper, so it must not be reported or closed here.
    if (!child.parentId || ownedByEngine(child, false)) return;
    const parentId = child.parentId;
    const parent = this.deps.getInstance(parentId);
    const canNotify = (): boolean => this.isParentCurrent(parentId, parent) && child.parentId === parentId;
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
          parentId,
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
    if (canNotify()) this.addParentNotification(child, childId, exitCode, childSummaryData);

    taskManager.cleanupChildTasks(childId);

    const resultData = childSummaryData
      ? {
          name: child.displayName,
          summary: childSummaryData.summary,
          success: childSummaryData.success,
          conclusions: childSummaryData.conclusions,
        }
      : undefined;

    if (!canNotify()) {
      await this.emitCompletionHook(child, childId, exitCode, childSummaryData, parentId);
      await this.terminateChild(childId);
      return;
    }
    const { remainingChildren: remainingAtExit } = orchestration.notifyChildTerminated(
      parentId,
      childId,
      resultData,
      { deliver: false },
    );

    logger.info('Child exited, parent notified', { childId, exitCode, parentId: child.parentId, remainingChildren: remainingAtExit });
    await this.emitCompletionHook(child, childId, exitCode, childSummaryData, parentId);
    if (!canNotify()) {
      await this.terminateChild(childId);
      return;
    }

    const remainingChildren = orchestration.getActiveChildCount(parentId);
    if (remainingChildren === 0) {
      this.batcher.noteParentSettled(parentId);
      await this.finishAllCompletedChildren(parentId, orchestration, storage, canNotify);
      return;
    }

    const decision = this.batcher.decide(parentId, childId, {
      success: resultData?.success === true && exitCode === 0,
    });
    // A failed sibling releases held results synchronously; delivery observers
    // can remove the parent or shut down the owner before decide returns.
    if (!canNotify()) {
      await this.terminateChild(childId);
      return;
    }
    if (decision === 'final') {
      await this.finishAllCompletedChildren(parentId, orchestration, storage, canNotify);
    } else {
      if (decision === 'hold') {
        this.batcher.hold(parentId, childId, resultData);
      } else {
        orchestration.deliverChildCompleted(parentId, childId, resultData);
        this.batcher.markReported(parentId, childId);
      }
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
        ? `Child errored before producing a reply: ${errorMessageText(lastError).substring(0, 500)}`
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
    parentId: string,
  ): Promise<void> {
    if (!parentId) {
      return;
    }

    const childFailed = childSummaryData?.success === false || exitCode !== 0;
    if (child.provider === 'codex' && child.providerSessionId) {
      recordSessionPolicy({
        provider: 'codex', recordType: 'child-outcome', threadId: child.providerSessionId,
        instanceId: childId, parentId, exitCode,
        success: childFailed ? false : childSummaryData?.success ?? null,
      });
    }
    const buildDiagnostic =
      this.deps.buildDiagnosticBundle ??
      ((target, reason) => buildChildDiagnosticBundle(target, reason));
    const diagnosticBundle = childFailed
      ? await buildDiagnostic(child, this.getChildTimeoutReason(child)).catch((error: unknown) => {
          logger.warn('Failed to build child diagnostic bundle', {
            childId,
            parentId,
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        })
      : undefined;
    emitPluginHook(childFailed ? 'orchestration.child.failed' : 'orchestration.child.completed', {
      parentId,
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
    parentId: string,
    orchestration: ChildCompletionOrchestration,
    storage: ChildCompletionStorage,
    canNotify: () => boolean,
  ): Promise<void> {
    if (!canNotify()) return;
    const completedIds = orchestration.getCompletedChildIds(parentId);
    const pendingIds = this.batcher.takeUnreported(parentId, completedIds);
    const summaries = await Promise.all(
      pendingIds.map(async (cId) => {
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

    if (summaries.length > 0 && canNotify()) {
      const options = orchestration.getActiveChildCount(parentId) > 0 ? { othersStillRunning: true } : undefined;
      orchestration.notifyAllChildrenCompleted(parentId, summaries, options);
      logger.info('All children completed, synthesis prompt injected', { parentId, childCount: summaries.length });
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
