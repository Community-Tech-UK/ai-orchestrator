import { isProjectRailHiddenSession } from '../../shared/utils/project-rail-hidden-session';
import type { InstanceManager } from '../instance/instance-manager';
import type { Instance } from '../../shared/types/instance.types';
import type { ConversationHistoryEntry } from '../../shared/types/history.types';
import type { WorkAdmission } from '../work-admission/work-admission';
import type { SessionRevivalRequest, SessionRevivalResult } from '../session/session-revival-service';
import { adapterHasActiveProviderTurn, adapterHasActiveToolCalls, adapterHasPendingLiveAsk } from '../instance/stuck-process-detector';
import { createMaintenanceDependencies } from './source-update-maintenance-runtime';

/** Only identities travel through the external helper; History owns conversation and routing. */
export interface IdleSourceUpdateSession {
  instanceId: string;
  historyEntryId: string;
  providerSessionId?: string;
  workingDirectory: string;
  accountProfileId?: string;
}
export interface SourceUpdateMaintenanceLease {
  sessions: IdleSourceUpdateSession[];
  recheck(): boolean;
  release(): void;
}
type SavedRouting = Pick<ConversationHistoryEntry, 'id' | 'originalInstanceId' | 'historyThreadId' | 'provider' | 'sessionId' | 'workingDirectory' | 'accountProfileId' | 'copilotAccountProfileId' | 'executionLocation' | 'nativeResumeFailedAt' | 'isHiddenAutomation' | 'hideFromProjectRail'>;
export interface SourceUpdateMaintenanceDependencies {
  admission: WorkAdmission;
  hasActiveWork(): boolean;
  hasSessionWork(instanceId: string): boolean;
  archive(instance: Instance): Promise<unknown>;
  findHistoryEntry(instance: Instance): SavedRouting | undefined;
  revive(request: SessionRevivalRequest): Promise<SessionRevivalResult>;
}
const CLOSED = new Set<Instance['status']>(['terminated', 'superseded', 'failed']);
const IDLE = new Set<Instance['status']>(['idle', 'ready', 'hibernated', 'cancelled', 'error']);

/** Never interrupts work. The exclusive admission lease only covers the final activation handoff. */
export function createSourceUpdateMaintenance(manager: InstanceManager, supplied?: SourceUpdateMaintenanceDependencies) {
  const deps = supplied ?? createMaintenanceDependencies(manager);
  let owned: { release(): void } | null = null;
  let disposed = false;
  const sessions = (): Instance[] => manager.getAllInstances().filter(instance => !CLOSED.has(instance.status));
  const isIdle = (): boolean => !disposed && !deps.hasActiveWork() && sessions().every(instance => {
    const adapter = manager.getAdapter(instance.id);
    return IDLE.has(instance.status) && !instance.readyPromise && !instance.waitReason && !instance.activeTurnId
      && !deps.hasSessionWork(instance.id) && !adapterHasActiveProviderTurn(adapter)
      && !adapterHasActiveToolCalls(adapter) && !adapterHasPendingLiveAsk(adapter);
  });
  // Detect input, replacement runtimes, newly opened/closed sessions, or unsolicited provider output.
  const identity = (): string => JSON.stringify(sessions().map(instance => [instance.id, instance.status,
    instance.lastActivity, instance.requestCount, instance.adapterGeneration, instance.sessionId,
    instance.providerSessionId, instance.provider, instance.workingDirectory, instance.accountProfileId,
    instance.copilotAccountProfileId, instance.executionLocation, instance.outputBuffer.length,
    instance.outputBuffer.at(-1)?.id]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  const releaseOwned = (): void => { const current = owned; owned = null; current?.release(); };
  return {
    isIdle,
    async tryAcquire(): Promise<SourceUpdateMaintenanceLease | null> {
      if (owned || !isIdle()) return null;
      const lease = deps.admission.tryAcquireMaintenance();
      if (!lease) return null;
      owned = lease;
      let handedOff = false;
      try {
        if (!isIdle()) return null;
        const before = identity();
        const captured: IdleSourceUpdateSession[] = [];
        for (const instance of sessions()) {
          // Completed helpers and hidden engine workers are transient; their owning root is retained.
          if (instance.parentId || isProjectRailHiddenSession(instance.metadata)) continue;
          if (!instance.historyThreadId) return null;
          await deps.archive(instance);
          if (!isIdle() || identity() !== before) return null;
          const entry = deps.findHistoryEntry(instance);
          // History already owns which successful background jobs and side chats remain hidden.
          if (entry?.isHiddenAutomation || entry?.hideFromProjectRail) continue;
          // The existing restore coordinator cannot faithfully reconstruct these runtime routes yet.
          if (instance.modelRuntimeTarget || (instance.executionLocation?.type === 'local' && instance.nodePlacement)) return null;
          const providerSessionId = instance.providerSessionId ?? instance.sessionId;
          if (!entry || entry.provider !== instance.provider || entry.workingDirectory !== instance.workingDirectory
            || entry.accountProfileId !== instance.accountProfileId || entry.copilotAccountProfileId !== instance.copilotAccountProfileId
            || JSON.stringify(entry.executionLocation) !== JSON.stringify(instance.executionLocation)
            || (entry.sessionId !== providerSessionId && entry.nativeResumeFailedAt == null)) return null;
          captured.push({ instanceId: instance.id, historyEntryId: entry.id, workingDirectory: instance.workingDirectory,
            ...(providerSessionId ? { providerSessionId } : {}), ...(instance.accountProfileId ? { accountProfileId: instance.accountProfileId } : {}) });
        }
        if (!isIdle() || identity() !== before || owned !== lease) return null;
        handedOff = true;
        return { sessions: captured,
          recheck: () => owned === lease && deps.admission.isInMaintenance() && isIdle() && identity() === before,
          release: () => { if (owned === lease) releaseOwned(); },
        };
      } finally { if (!handedOff && owned === lease) releaseOwned(); }
    },
    async restore(saved: readonly IdleSourceUpdateSession[]): Promise<void> {
      const failures: string[] = [];
      for (const session of saved) {
        // Revival restores transcript and provider routing; no continuation or new input is sent.
        try {
          const result = await deps.revive({ ...session, reviveIfArchived: true, reason: 'source-update' });
          if (result.status === 'failed' || !result.instanceId) { failures.push(session.instanceId); continue; }
          const reopened = manager.getInstance(result.instanceId);
          if (!reopened) { failures.push(session.instanceId); continue; }
          await reopened.readyPromise;
          if (['error', 'failed', 'terminated', 'cancelled', 'superseded', 'degraded'].includes(reopened.status)) failures.push(session.instanceId);
        } catch { failures.push(session.instanceId); }
      }
      if (failures.length) throw new Error('Some conversations could not be reopened after the update. Open them from History.');
    },
    dispose(): void { disposed = true; releaseOwned(); },
  };
}
