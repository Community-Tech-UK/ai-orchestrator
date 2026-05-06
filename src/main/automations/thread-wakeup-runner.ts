import type {
  Automation,
  AutomationDestination,
  AutomationRun,
} from '../../shared/types/automation.types';
import type { InstanceManager } from '../instance/instance-manager';
import { getLogger } from '../logging/logger';
import type { SessionRevivalService } from '../session/session-revival-service';
import type { AutomationStore } from './automation-store';

const logger = getLogger('ThreadWakeupRunner');

type ThreadDestination = Extract<AutomationDestination, { kind: 'thread' }>;
type InstanceInput = Pick<InstanceManager, 'sendInput'>;
type RevivalInput = Pick<SessionRevivalService, 'revive'>;
type WakeupStore = Pick<AutomationStore, 'attachInstance' | 'terminalizeRun'>;

export interface ThreadWakeupRequest {
  run: AutomationRun;
  automation: Automation;
  destination: ThreadDestination;
}

export class ThreadWakeupRunner {
  constructor(
    private readonly instanceManager: InstanceInput,
    private readonly revival: RevivalInput,
    private readonly store: WakeupStore,
    private readonly now = () => Date.now(),
  ) {}

  async fireThreadWakeup(request: ThreadWakeupRequest): Promise<AutomationRun> {
    const { run, automation, destination } = request;
    const revived = await this.reviveTarget(automation, destination);

    if (revived.status === 'failed' || !revived.instanceId) {
      const reason = `Thread wakeup failed: ${revived.failureCode ?? 'target_missing'}${revived.error ? ` (${revived.error})` : ''}`;
      return this.fail(run, reason);
    }

    const instanceId = revived.instanceId;
    this.store.attachInstance(run.id, instanceId, this.now());

    try {
      await this.instanceManager.sendInput(
        instanceId,
        automation.action.prompt,
        automation.action.attachments,
      );
      const summary = `Wakeup prompt delivered to thread ${instanceId}.`;
      return this.terminalize(run, 'succeeded', undefined, summary);
    } catch (error) {
      const reason = `Thread wakeup send failed: ${error instanceof Error ? error.message : String(error)}`;
      logger.warn('Thread wakeup send failed', {
        automationId: automation.id,
        runId: run.id,
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.fail(run, reason);
    }
  }

  private async reviveTarget(
    automation: Automation,
    destination: ThreadDestination,
  ): ReturnType<RevivalInput['revive']> {
    try {
      return await this.revival.revive({
        instanceId: destination.instanceId,
        historyEntryId: destination.historyEntryId,
        providerSessionId: destination.sessionId,
        workingDirectory: automation.action.workingDirectory,
        reviveIfArchived: destination.reviveIfArchived,
        reason: 'thread-wakeup',
      });
    } catch (error) {
      return {
        status: 'failed',
        failureCode: 'resume_failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private fail(run: AutomationRun, reason: string): AutomationRun {
    return this.terminalize(run, 'failed', reason);
  }

  private terminalize(
    run: AutomationRun,
    status: 'succeeded' | 'failed',
    error?: string,
    outputSummary?: string,
  ): AutomationRun {
    const terminal = this.store.terminalizeRun(
      run.id,
      status,
      error,
      outputSummary,
      this.now(),
    );
    if (!terminal) {
      throw new Error(`Thread wakeup run ${run.id} could not be terminalized`);
    }
    return terminal;
  }
}
