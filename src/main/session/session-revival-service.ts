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
  /** Continue the revived session on this account instead of the one it was archived with. */
  accountProfileId?: string;
  reviveIfArchived: boolean;
  reason: 'thread-wakeup' | 'history-restore' | 'global-pause-resume';
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

/** Copies that no longer hold the conversation; it is reopened from history. */
const CLOSED_STATUSES = new Set<InstanceStatus>(['superseded', 'failed', 'terminated']);
/**
 * Open copies that take no input until restarted. They are restarted in place:
 * opening a second copy beside one leaves two runtimes on the same conversation.
 * A hibernated copy needs nothing here, because sending input wakes it.
 */
const RESTART_STATUSES = new Set<InstanceStatus>(['error', 'cancelled']);

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
    let entry: ConversationHistoryEntry | undefined;
    let historyError: unknown;
    try {
      entry = this.findHistoryEntry(request);
    } catch (error) {
      historyError = error;
    }

    const openCopy = this.findOpenInstance(request, entry);
    if (openCopy && !RESTART_STATUSES.has(openCopy.status)) {
      return {
        status: 'live',
        instanceId: openCopy.id,
      };
    }

    if (!request.reviveIfArchived) {
      return {
        status: 'failed',
        failureCode: 'target_not_live',
      };
    }

    if (openCopy) {
      return this.restartInPlace(openCopy.id);
    }

    if (historyError) {
      return {
        status: 'failed',
        failureCode: 'resume_failed',
        error: historyError instanceof Error ? historyError.message : String(historyError),
      };
    }

    const historyEntryId = entry?.id ?? this.normalizeIdentifier(request.historyEntryId);
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
        {
          workingDirectory: request.workingDirectory,
          ...(request.accountProfileId ? { accountProfileId: request.accountProfileId } : {}),
        },
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

  /** Prefers a copy that can take input; otherwise a stopped copy to restart. */
  private findOpenInstance(
    request: SessionRevivalRequest,
    entry: ConversationHistoryEntry | undefined,
  ): Instance | null {
    const requested = request.instanceId
      ? this.instanceManager.getInstance(request.instanceId)
      : undefined;
    const identifiers = this.getLookupIdentifiers(request, entry);
    const matches = typeof this.instanceManager.getAllInstances === 'function'
      ? this.instanceManager.getAllInstances().filter((instance) => this.instanceMatches(instance, identifiers))
      : [];
    const open = [requested, ...matches].filter((instance): instance is Instance =>
      Boolean(instance && !CLOSED_STATUSES.has(instance.status))
    );
    return open.find((instance) => !RESTART_STATUSES.has(instance.status)) ?? open[0] ?? null;
  }

  private async restartInPlace(instanceId: string): Promise<SessionRevivalResult> {
    try {
      const outcome = await this.instanceManager.restartInstance(instanceId);
      if (outcome.success) {
        return { status: 'revived', instanceId };
      }
      return { status: 'failed', failureCode: 'resume_failed', error: outcome.error ?? 'Restart failed' };
    } catch (error) {
      return {
        status: 'failed',
        failureCode: 'resume_failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private findHistoryEntry(request: SessionRevivalRequest): ConversationHistoryEntry | undefined {
    const requestedEntryId = this.normalizeIdentifier(request.historyEntryId);
    const entries = this.history().getEntries();
    const exactEntry = requestedEntryId
      ? entries.find((entry) => entry.id === requestedEntryId)
      : undefined;
    if (exactEntry) {
      return exactEntry;
    }

    const identifiers = this.getLookupIdentifiers(request);
    return entries.find((entry) => this.entryMatches(entry, identifiers));
  }

  private getLookupIdentifiers(request: SessionRevivalRequest, entry?: ConversationHistoryEntry): Set<string> {
    const identifiers = [
      request.instanceId,
      request.historyEntryId,
      request.providerSessionId,
      entry?.originalInstanceId,
      entry?.historyThreadId,
      entry?.sessionId,
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
