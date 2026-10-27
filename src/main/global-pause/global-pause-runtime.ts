import type { GlobalPauseEntry } from '@contracts/schemas/global-pause';
import type { AutomationRun } from '../../shared/types/automation.types';
import type { Instance, InstanceStatus } from '../../shared/types/instance.types';
import type { InstanceManager } from '../instance/instance-manager';
import { getSettingsManager } from '../core/config/settings-manager';
import { GlobalPauseService } from './global-pause-service';
import { pauseConsults } from '../work-admission/consult-admission';
import { ownedByEngine } from '../work-admission/engine-ownership';
import { getPlanQueueCoordinator } from '../plan-queue/plan-queue-coordinator';
import { getLoopCoordinator } from '../orchestration/loop-coordinator';
import { getLoopStore } from '../orchestration/loop-store';
import { resumeLoopRun } from '../orchestration/loop-resume';
import { getCampaignCoordinator } from '../orchestration/campaign-coordinator';
import { releaseAutomationOwnership } from '../automations/automation-hidden-outcome';
import { getAutomationRunner, getAutomationStore } from '../automations';
import { SessionRevivalService } from '../session/session-revival-service';
import { getSessionQueueService } from '../session/session-queue-service';
import { getRepoJobService } from '../repo-jobs/repo-job-service';
import { globalPauseAutomationResumePrompt, globalPauseNotePrompt, globalPauseResumePrompt } from './global-pause-prompts';
import type { GlobalPauseRuntime, PauseEngineSnapshot, PauseSessionSnapshot } from './global-pause-runtime.types';
import { GlobalPauseUnsafeError } from './global-pause-runtime.types';
import { isAdapterOnLoan } from '../instance/lifecycle/adapter-loan-registry';
import { getWorkAdmission } from '../work-admission/work-admission';
import { getPromptHistoryService } from '../prompt-history/prompt-history-service';
import { hasConfiguredInitialPrompt } from '../instance/lifecycle/initial-prompt-dispatch';
import { hasPendingInitialPrompt, retryPendingInitialPrompt } from '../instance/lifecycle/initial-prompt-recovery';
import { withOperationDeadline } from '../runtime/operation-deadline';

const BUSY = new Set<InstanceStatus>(['initializing', 'busy', 'processing', 'thinking_deeply', 'waiting_for_input', 'waiting_for_permission', 'interrupting', 'respawning']);
const CLOSED = new Set<InstanceStatus>(['terminated', 'superseded', 'failed']);
function stillStarting(instance: Instance): boolean {
  return hasPendingInitialPrompt(instance) || instance.status === 'initializing' || Boolean(instance.readyPromise && ['idle', 'ready'].includes(instance.status));
}
function lastText(instance: Instance, type: 'user' | 'assistant'): string {
  return [...instance.outputBuffer].reverse().find((message) => message.type === type)?.content ?? '';
}
function hasInitialTask(instance: Instance): boolean {
  const configured = hasConfiguredInitialPrompt(instance);
  if (configured !== undefined) return configured;
  return Boolean(lastText(instance, 'user') || instance.outputBuffer.some(message => message.type === 'user' && message.attachments?.length)
    || getPromptHistoryService().getForInstance(instance.id).entries[0]?.text);
}
function helperParent(instance: Instance): string | null {
  return instance.parentId ?? (typeof instance.metadata?.['spawnParentInstanceId'] === 'string' ? instance.metadata['spawnParentInstanceId'] : null);
}
function isHelperOf(instance: Instance, parentId: string, instances: Instance[]): boolean {
  const seen = new Set<string>();
  let parent = helperParent(instance);
  while (parent && !seen.has(parent)) {
    if (parent === parentId) return true;
    seen.add(parent);
    const ancestor = instances.find((candidate) => candidate.id === parent);
    parent = ancestor ? helperParent(ancestor) : null;
  }
  return false;
}

export function createGlobalPauseRuntime(manager: InstanceManager): GlobalPauseRuntime {
  const revival = new SessionRevivalService(manager);
  const sessions = (): PauseSessionSnapshot[] => {
    const instances = manager.getAllInstances();
    return instances.filter((instance) => !helperParent(instance) && !ownedByEngine(instance, false) && !CLOSED.has(instance.status)).map((instance) => ({
      ...(stillStarting(instance) ? { waitingForInitialization: true } : {}),
      id: instance.id, displayName: instance.displayName, workspace: instance.workingDirectory, provider: instance.provider,
      historyThreadId: instance.historyThreadId, providerSessionId: instance.providerSessionId ?? instance.sessionId,
      busy: (BUSY.has(instance.status) && !stillStarting(instance)) || (stillStarting(instance) && hasInitialTask(instance)) || isAdapterOnLoan(instance.id)
        || instances.some((child) => isHelperOf(child, instance.id, instances) && !ownedByEngine(child) && !CLOSED.has(child.status)) || ['hibernated', 'degraded', 'cancelled', 'error'].includes(instance.status) || instance.waitReason?.kind === 'quota-park',
      lastRequest: lastText(instance, 'user') || (stillStarting(instance) ? getPromptHistoryService().getForInstance(instance.id).entries[0]?.text ?? '' : ''), lastReply: lastText(instance, 'assistant'),
      helperReplies: instances.filter((child) => isHelperOf(child, instance.id, instances) && !ownedByEngine(child))
        .map((child) => `${child.displayName}: ${lastText(child, 'assistant').slice(0, 1500)}`),
      ...(instance.waitReason?.kind === 'quota-park' ? { unavailableReason: 'The session was waiting for its usage limit to reset.' } : {}),
      ...(['hibernated', 'error', 'cancelled', 'degraded'].includes(instance.status)
        ? { unavailableReason: 'The session could not be asked for a note; its latest conversation is saved here.' } : {}),
      ...(stillStarting(instance) ? { unavailableReason: 'The session was still starting. Its first message will wait for Resume.' } : {}),
    }));
  };
  const linkedThreadRuns = (identities: (string | null | undefined)[]): AutomationRun[] => {
    const entries = GlobalPauseService.peek()?.getState().entries ?? [];
    const result: AutomationRun[] = [];
    for (const entry of entries.filter(entry => entry.kind === 'automation-run' && !['void', 'resumed', 'failed'].includes(entry.state))) {
      const run = getAutomationStore().getRun(entry.targetId);
      if (run?.status === 'running' && run.configSnapshot?.destination.kind === 'thread' && run.instanceId && identities.includes(run.instanceId)) result.push(run);
    }
    return result;
  };
  const threadTargetEntry = (run: AutomationRun): GlobalPauseEntry | undefined => {
    const target = run.configSnapshot?.destination;
    if (target?.kind !== 'thread') return undefined;
    const identities = [run.instanceId, target.instanceId, target.historyEntryId, target.sessionId].filter(Boolean);
    return GlobalPauseService.peek()?.getState().entries.find(entry => entry.kind === 'session'
      && [entry.targetId, entry.originalInstanceId, entry.historyThreadId, entry.providerSessionId].some(id => id && identities.includes(id)));
  };
  const threadOwnershipLoss = (run: AutomationRun): string | null => {
    const session = threadTargetEntry(run);
    return session?.state === 'void' ? session.voidReason === 'picked-up-by-james'
      ? 'James picked up the target session while paused' : 'The target session was closed while paused' : null;
  };
  return {
    sessions,
    targetVoided: (identities, reason) => {
      const state = GlobalPauseService.peek()?.getState();
      if (!state) return;
      const recorded = state.entries.filter(entry => entry.kind === 'automation-run');
      for (const run of getAutomationStore().listActiveRuns().filter(run => run.status === 'running')) {
        const entry = recorded.find(entry => entry.targetId === run.id);
        if (state.phase !== 'collecting' && !entry) continue;
        const target = run.configSnapshot?.destination;
        const live = run.instanceId ? manager.getInstance(run.instanceId) : undefined;
        const aliases = [run.instanceId, live?.historyThreadId, live?.providerSessionId, live?.sessionId,
          entry?.originalInstanceId, entry?.historyThreadId, entry?.providerSessionId,
          ...(target?.kind === 'thread' ? [target.instanceId, target.historyEntryId, target.sessionId] : [])];
        const metadataMatch = identities.some(id => manager.getInstance(id)?.metadata?.['automationRunId'] === run.id);
        if (metadataMatch || aliases.some(id => id && identities.includes(id))) {
          if (reason === 'picked-up-by-james') {
            for (const instance of manager.getAllInstances()) releaseAutomationOwnership(manager, instance.id, run.id);
          }
          getAutomationRunner().cancelRunForGlobalPause(run.id, reason === 'picked-up-by-james'
            ? 'James picked up the target session while paused' : 'The target session was closed while paused');
        }
      }
    },
    sessionIdentities: (id) => {
      const instance = manager.getInstance(id);
      return [id, instance?.historyThreadId, instance?.providerSessionId, instance?.sessionId].filter((identity): identity is string => Boolean(identity));
    },
    runningWork: () => ({ sessions: manager.getAllInstances().filter((instance) => !helperParent(instance) && !ownedByEngine(instance)
      && ['busy', 'processing', 'thinking_deeply', 'initializing'].includes(instance.status)).length,
      queueJobs: getWorkAdmission().getCounts()['queue-job'] ?? 0,
      loops: getLoopCoordinator().getActiveLoops().filter((loop) => Boolean(loop.inFlightIteration)).length }),
    level: () => getSettingsManager().get('workloadLevel') ?? 3,
    engines: async () => {
      const queue = getPlanQueueCoordinator();
      return [
        ...(queue.isInitialized() ? queue.store.listActiveRuns().filter((run) => run.status === 'running')
          .map((run): PauseEngineSnapshot => ({ kind: 'queue-run', id: run.id, displayName: 'Plan Queue run' })) : []),
        ...getLoopCoordinator().getActiveLoops().filter((loop) => loop.status === 'running')
          .map((loop): PauseEngineSnapshot => ({ kind: 'loop', id: loop.id, displayName: 'Loop' })),
        ...getCampaignCoordinator().listRunningCampaigns()
          .map((campaign): PauseEngineSnapshot => ({ kind: 'campaign', id: campaign.id, displayName: campaign.spec.title })),
        ...getAutomationStore().listActiveRuns().filter((run) => run.status === 'running')
          .map((run): PauseEngineSnapshot => {
            const instance = run.instanceId ? manager.getInstance(run.instanceId) : undefined;
            return { kind: 'automation-run', id: run.id, displayName: run.configSnapshot?.name ?? 'Scheduled job',
              originalInstanceId: run.instanceId, historyThreadId: instance?.historyThreadId,
              providerSessionId: instance?.providerSessionId ?? instance?.sessionId };
          }),
        ...getRepoJobService().getRunningJobsForGlobalPause()
          .map((job): PauseEngineSnapshot => ({ kind: 'repo-job', id: job.id, displayName: 'Repository job' })),
      ];
    },
    pauseEngines: async (entries) => {
      const queue = getPlanQueueCoordinator();
      // Checkpoints complete first. Never interrupt queue sessions from a generic loop.
      // Runs share a landing queue: request every stop before awaiting any run.
      // Drain all attempts on failure too, so a retry cannot overlap old checkpoints.
      const checkpoints = await Promise.allSettled(entries.filter(item => item.kind === 'queue-run')
        .map(entry => queue.control({ action: 'pause', runId: entry.id })));
      const failed = checkpoints.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      await pauseConsults();
      for (const entry of entries.filter((item) => item.kind === 'campaign')) getCampaignCoordinator().pauseForGlobalPause(entry.id);
      for (const entry of entries.filter((item) => item.kind === 'repo-job')) await getRepoJobService().pauseForGlobalPause(entry.id);
      for (const entry of entries.filter((item) => item.kind === 'loop')) await getLoopCoordinator().pauseForGlobalPause(entry.id);
      for (const entry of entries.filter((item) => item.kind === 'automation-run')) {
        getAutomationRunner().pauseRunForGlobalPause(entry.id);
        const run = getAutomationStore().getRun(entry.id);
        if (!run || run.status !== 'running') continue;
        const lost = threadOwnershipLoss(run);
        if (lost) { getAutomationRunner().cancelRunForGlobalPause(run.id, lost); continue; }
        if (!run.instanceId) continue;
        const instance = manager.getInstance(run.instanceId);
        if (instance && BUSY.has(instance.status)) {
          const controller = new AbortController();
          const pause = GlobalPauseService.peek();
          let ownershipLost = false;
          const changed = (): void => {
            if (ownershipLost) return;
            const current = getAutomationStore().getRun(run.id);
            const reason = current ? threadOwnershipLoss(current) : null;
            if (!current || current.status !== 'running' || reason) {
              ownershipLost = true; controller.abort();
              if (reason) getAutomationRunner().cancelRunForGlobalPause(run.id, reason);
            }
          };
          pause?.on('state-changed', changed);
          try {
            changed();
            if (ownershipLost) continue;
            manager.interruptInstance(instance.id, 'pause');
            await manager.waitForInstanceSettled(instance.id, { timeoutMs: 31_000, signal: controller.signal });
          } catch (error) { if (!ownershipLost) throw error; }
          finally { pause?.off('state-changed', changed); }
        }
      }
    },
    stopHelpers: async (sessionId) => {
      const instances = manager.getAllInstances();
      for (const child of instances.filter((instance) => isHelperOf(instance, sessionId, instances) && !ownedByEngine(instance))) {
        if (manager.getInstance(child.id)) await manager.terminateInstance(child.id, true);
      }
    },
    interruptSession: async (session) => {
      const instance = manager.getInstance(session.id);
      const pause = GlobalPauseService.peek();
      const controller = new AbortController();
      let ownershipLost = false;
      const changed = (): void => {
        if (pause && !pause.holdsAutomaticInput(session.id)) { ownershipLost = true; controller.abort(); }
      };
      pause?.on('state-changed', changed);
      try {
        changed(); if (ownershipLost) return false;
        if (instance && hasPendingInitialPrompt(instance) && !instance.readyPromise) {
          try { await retryPendingInitialPrompt(instance); }
          catch { throw new GlobalPauseUnsafeError('The first message could not be saved. Try Pause for restart again before restarting.'); }
          return false;
        }
        if (instance?.readyPromise && session.unavailableReason?.includes('still starting')) {
          try { await withOperationDeadline({ name: 'global-pause-initialization', owner: session.id, deadlineMs: 31_000,
            signal: controller.signal, operation: instance.readyPromise }); }
          catch { if (!ownershipLost) throw new GlobalPauseUnsafeError('A session is still starting. Wait for it to finish before restarting.'); }
          return false;
        }
        if (!instance || session.unavailableReason) return false;
        if (!BUSY.has(instance.status)) return true;
        manager.interruptInstance(session.id, 'pause');
        try {
          const settled = await withOperationDeadline({ name: 'global-pause-session-interrupt', owner: session.id, deadlineMs: 31_000,
            signal: controller.signal, operation: () => manager.waitForInstanceSettled(session.id, { timeoutMs: 31_000, signal: controller.signal }) });
          return settled !== undefined && !['cancelled', 'error', 'failed', 'terminated', 'degraded'].includes(settled.status);
        } catch {
          if (ownershipLost) return false;
          const adapter = manager.getAdapter(session.id);
          try { if (adapter) await adapter.terminate(false); }
          catch { throw new GlobalPauseUnsafeError('A session could not be stopped. Check it before restarting.'); }
          return false;
        }
      } finally { pause?.off('state-changed', changed); }
    },
    collectNote: async (session, signal) => {
      signal.throwIfAborted();
      const startedAt = Date.now();
      const deadline = new AbortController();
      const combined = AbortSignal.any([signal, deadline.signal]);
      const interrupt = (): void => { manager.interruptInstance(session.id, 'pause'); };
      combined.addEventListener('abort', interrupt, { once: true });
      let collected = false;
      let note: string | null = null;
      let failure: unknown;
      try {
        // Provider preparation can ignore cancellation until its await returns.
        // Bound our wait as well as cancelling dispatch, then prove the turn stopped below.
        const settled = await withOperationDeadline({ name: 'global-pause-note', owner: session.id,
          deadlineMs: 180_000, signal: combined, onTimeout: () => deadline.abort(),
          operation: async () => {
            await manager.sendInput(session.id, globalPauseNotePrompt(session.helperReplies), undefined, { internalSource: 'global-pause-note', signal: combined });
            combined.throwIfAborted();
            return manager.waitForInstanceSettled(session.id, { afterTimestamp: startedAt, timeoutMs: 180_000, signal: combined });
          } });
        if (!combined.aborted) {
          collected = true;
          const reply = settled ? [...settled.outputBuffer].reverse().find((message) => message.type === 'assistant' && message.timestamp >= startedAt) : undefined;
          note = reply?.content.trim() || null;
        }
      } catch (error) { failure = error; }
      finally { combined.removeEventListener('abort', interrupt); }
      // Once James picks the session up, cleanup must leave his replacement turn alone.
      if (!collected && GlobalPauseService.peek()?.holdsAutomaticInput(session.id)) {
        manager.interruptInstance(session.id, 'pause');
        try { await manager.waitForInstanceSettled(session.id, { timeoutMs: 31_000 }); }
        catch { throw new GlobalPauseUnsafeError('The note turn has not stopped. Check the session before restarting.'); }
      }
      if (failure) throw failure;
      return note;
    },
    resumeSession: async (entry) => {
      const restored = await revival.revive({ instanceId: entry.targetId,
        historyEntryId: entry.historyThreadId ?? undefined, providerSessionId: entry.providerSessionId ?? undefined,
        workingDirectory: entry.workspace ?? undefined, reviveIfArchived: true, reason: 'global-pause-resume' });
      if (!restored.instanceId || restored.status === 'failed') {
        throw new Error('This session could not be reopened. Reopen it from History by hand.');
      }
      const pause = GlobalPauseService.peek();
      const stillRecorded = (): boolean => !pause || pause.getState().entries.some((current) => current.id === entry.id
        && !['void', 'failed', 'resumed'].includes(current.state));
      if (!stillRecorded()) return restored.instanceId;
      getSessionQueueService().reassignQueue(entry.targetId, restored.instanceId);
      pause?.bindSessionIdentity(entry.id, restored.instanceId);
      if (stillRecorded() && entry.wasBusy && entry.voidReason !== 'initial-prompt-queued') {
        const threadRuns = linkedThreadRuns([entry.targetId, entry.originalInstanceId, entry.historyThreadId, entry.providerSessionId, restored.instanceId]);
        for (const run of threadRuns) getAutomationRunner().resumeRunForGlobalPause(run.id, restored.instanceId);
        const controller = new AbortController();
        let ownershipLost = false;
        const pickedUp = (): void => {
          if (!stillRecorded() && !ownershipLost) {
            ownershipLost = true; controller.abort();
            for (const run of threadRuns) getAutomationRunner().cancelRunForGlobalPause(run.id, 'James took over the target session while resuming');
          }
        };
        pause?.on('state-changed', pickedUp);
        try {
          pickedUp();
          const continuation = globalPauseResumePrompt(entry.noteText, entry.noteKind === 'agent' && (restored.status === 'live' || restored.restoreMode === 'native-resume'));
          const threadContext = threadRuns.map(run => globalPauseAutomationResumePrompt(run.configSnapshot?.action.prompt, run.configSnapshot?.action.attachments?.map(attachment => attachment.name))).join('\n\n');
          await manager.sendInput(restored.instanceId,
            threadContext ? `${continuation}\n\n${threadContext}` : continuation, undefined,
            { internalSource: 'global-pause-resume', signal: controller.signal });
        } finally { pause?.off('state-changed', pickedUp); }
      }
      return restored.instanceId;
    },
    resumeEngine: async (entry: GlobalPauseEntry) => {
      switch (entry.kind) {
        case 'queue-run': await getPlanQueueCoordinator().control({ action: 'resume', runId: entry.targetId }); break;
        case 'loop': {
          const outcome = await resumeLoopRun(getLoopCoordinator(), getLoopStore(), entry.targetId);
          if (!outcome.ok && outcome.state?.status !== 'running') throw new Error(outcome.reason ?? 'Loop could not resume');
          break;
        }
        case 'campaign': await getCampaignCoordinator().resumeCampaign(entry.targetId); break;
        case 'repo-job': if (!getRepoJobService().resumeForGlobalPause(entry.targetId)) throw new Error('Repository job could not resume'); break;
        case 'automation-run': {
          const run = getAutomationStore().getRun(entry.targetId);
          if (!run || run.status !== 'running') return;
          if (run) {
            const lost = threadOwnershipLoss(run);
            if (lost) { getAutomationRunner().cancelRunForGlobalPause(run.id, lost); return; }
          }
          if (!run?.instanceId) {
            if (run?.loopRunId) {
              getAutomationRunner().trackLoopRunForGlobalPause(entry.targetId, run.loopRunId);
              const outcome = await resumeLoopRun(getLoopCoordinator(), getLoopStore(), run.loopRunId);
              if (!outcome.ok && outcome.state?.status !== 'running') throw new Error(outcome.reason ?? 'Scheduled loop could not resume');
              break;
            }
            await getAutomationRunner().resumePendingRunForGlobalPause(entry.targetId);
            break;
          }
          if (run.configSnapshot?.destination.kind === 'thread') {
            const session = threadTargetEntry(run);
            if (session?.state === 'resumed' && session.wasBusy) {
              if (manager.getInstance(session.targetId)) getAutomationRunner().resumeRunForGlobalPause(entry.targetId, session.targetId);
              return;
            }
          }
          const controller = new AbortController();
          const pause = GlobalPauseService.peek();
          let ownershipLost = false;
          const changed = (): void => {
            if (ownershipLost) return;
            const current = getAutomationStore().getRun(run.id);
            const reason = current ? threadOwnershipLoss(current) : null;
            if (!current || current.status === 'cancelled' || reason) {
              ownershipLost = true; controller.abort();
              if (reason) getAutomationRunner().cancelRunForGlobalPause(run.id, reason);
            }
          };
          pause?.on('state-changed', changed);
          try {
            changed(); if (ownershipLost) return;
            const restored = await withOperationDeadline({ name: 'global-pause-automation-revival', owner: run.id,
              deadlineMs: 180_000, signal: controller.signal,
              operation: () => revival.revive({ instanceId: run.instanceId!, reviveIfArchived: true, reason: 'global-pause-resume' }) });
            changed(); if (ownershipLost) return;
            if (!restored.instanceId || restored.status === 'failed') throw new Error('Scheduled job could not be reopened from History');
            getAutomationRunner().resumeRunForGlobalPause(entry.targetId, restored.instanceId);
            const beforeProviderDispatch = (): void => { changed(); controller.signal.throwIfAborted(); };
            await withOperationDeadline({ name: 'global-pause-automation-continuation', owner: run.id,
              deadlineMs: 180_000, signal: controller.signal, operation: () => manager.sendInput(restored.instanceId!,
                globalPauseAutomationResumePrompt(run.configSnapshot?.action.prompt, run.configSnapshot?.action.attachments?.map(attachment => attachment.name)),
                undefined, { internalSource: 'global-pause-resume', signal: controller.signal, beforeProviderDispatch }) });
          } catch (error) { if (!ownershipLost) throw error; }
          finally { pause?.off('state-changed', changed); }
          break;
        }
      }
    },
  };
}
