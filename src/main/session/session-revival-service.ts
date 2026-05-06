import type { InstanceManager } from '../instance/instance-manager';
import {
  HistoryRestoreCoordinator,
  HistoryRestoreError,
  type HistoryRestoreCoordinatorResult,
} from '../history/history-restore-coordinator';
import { getHistoryManager, type HistoryManager } from '../history/history-manager';
import { isRemoteNodeReachable } from '../ipc/handlers/remote-node-check';
import type { ConversationHistoryEntry } from '../../shared/types/history.types';
import type { Instance, InstanceStatus, OutputMessage } from '../../shared/types/instance.types';

export interface SessionRevivalRequest {
  instanceId?: string;
  historyEntryId?: string;
  providerSessionId?: string;
  workingDirectory?: string;
  reviveIfArchived: boolean;
  reason: 'thread-wakeup' | 'history-restore';
}

export interface SessionRevivalResult {
  status: 'live' | 'revived' | 'failed';
  instanceId?: string;
  restoredMessages?: OutputMessage[];
  restoreMode?: 'native-resume' | 'resume-unconfirmed' | 'replay-fallback';
  failureCode?: 'target_missing' | 'target_not_live' | 'resume_failed';
  error?: string;
}

type HistoryRestoreDep = Pick<HistoryRestoreCoordinator, 'restore'>;
type HistoryLookupDep = Pick<HistoryManager, 'getEntries'>;

const NOT_LIVE_STATUSES = new Set<InstanceStatus>([
  'cancelled',
  'superseded',
  'hibernated',
  'error',
  'failed',
  'terminated',
]);

export class SessionRevivalService {
  private readonly historyRestore: HistoryRestoreDep;
  private readonly history: () => HistoryLookupDep;

  constructor(
    private readonly instanceManager: InstanceManager,
    deps: {
      historyRestore?: HistoryRestoreDep;
      history?: HistoryLookupDep | (() => HistoryLookupDep);
    } = {},
  ) {
    this.historyRestore = deps.historyRestore ?? new HistoryRestoreCoordinator({
      isRemoteNodeReachable,
    });
    if (!deps.history) {
      this.history = getHistoryManager;
    } else if ('getEntries' in deps.history) {
      this.history = () => deps.history as HistoryLookupDep;
    } else {
      this.history = deps.history;
    }
  }

  async revive(request: SessionRevivalRequest): Promise<SessionRevivalResult> {
    const liveInstance = this.findLiveInstance(request);
    if (liveInstance) {
      return {
        status: 'live',
        instanceId: liveInstance.id,
      };
    }

    if (!request.reviveIfArchived) {
      return {
        status: 'failed',
        failureCode: 'target_not_live',
      };
    }

    let historyEntryId: string | undefined;
    try {
      historyEntryId = this.resolveHistoryEntryId(request);
    } catch (error) {
      return {
        status: 'failed',
        failureCode: 'resume_failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!historyEntryId) {
      return {
        status: 'failed',
        failureCode: 'target_missing',
      };
    }

    try {
      const restored = await this.historyRestore.restore(
        this.instanceManager,
        historyEntryId,
        { workingDirectory: request.workingDirectory },
      );
      return this.toRevived(restored);
    } catch (error) {
      const failureCode = error instanceof HistoryRestoreError && error.code === 'HISTORY_NOT_FOUND'
        ? 'target_missing'
        : 'resume_failed';
      return {
        status: 'failed',
        failureCode,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private findLiveInstance(request: SessionRevivalRequest): Instance | null {
    if (request.instanceId) {
      const instance = this.instanceManager.getInstance(request.instanceId);
      if (this.isLive(instance)) {
        return instance;
      }
    }

    if (typeof this.instanceManager.getAllInstances !== 'function') {
      return null;
    }

    const identifiers = this.getLookupIdentifiers(request);
    return this.instanceManager.getAllInstances().find((instance) =>
      this.isLive(instance) && this.instanceMatches(instance, identifiers)
    ) ?? null;
  }

  private isLive(instance: Instance | undefined): instance is Instance {
    return Boolean(instance && !NOT_LIVE_STATUSES.has(instance.status));
  }

  private resolveHistoryEntryId(request: SessionRevivalRequest): string | undefined {
    const requestedEntryId = this.normalizeIdentifier(request.historyEntryId);
    const entries = this.history().getEntries();
    const exactEntry = requestedEntryId
      ? entries.find((entry) => entry.id === requestedEntryId)
      : undefined;
    if (exactEntry) {
      return exactEntry.id;
    }

    const identifiers = this.getLookupIdentifiers(request);
    const matchingEntry = entries.find((entry) => this.entryMatches(entry, identifiers));
    return matchingEntry?.id ?? requestedEntryId;
  }

  private getLookupIdentifiers(request: SessionRevivalRequest): Set<string> {
    const identifiers = [
      request.instanceId,
      request.historyEntryId,
      request.providerSessionId,
    ]
      .map((value) => this.normalizeIdentifier(value))
      .filter((value): value is string => Boolean(value));
    return new Set<string>(identifiers);
  }

  private entryMatches(entry: ConversationHistoryEntry, identifiers: ReadonlySet<string>): boolean {
    if (identifiers.size === 0) {
      return false;
    }

    return [
      entry.id,
      entry.originalInstanceId,
      entry.historyThreadId,
      entry.sessionId,
    ].some((value) => {
      const normalized = this.normalizeIdentifier(value);
      return normalized ? identifiers.has(normalized) : false;
    });
  }

  private instanceMatches(instance: Instance, identifiers: ReadonlySet<string>): boolean {
    if (identifiers.size === 0) {
      return false;
    }

    return [
      instance.id,
      instance.historyThreadId,
      instance.sessionId,
      instance.providerSessionId,
    ].some((value) => {
      const normalized = this.normalizeIdentifier(value);
      return normalized ? identifiers.has(normalized) : false;
    });
  }

  private normalizeIdentifier(value: string | null | undefined): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
  }

  private toRevived(result: HistoryRestoreCoordinatorResult): SessionRevivalResult {
    return {
      status: 'revived',
      instanceId: result.instanceId,
      restoredMessages: result.restoredMessages,
      restoreMode: result.restoreMode,
    };
  }
}
