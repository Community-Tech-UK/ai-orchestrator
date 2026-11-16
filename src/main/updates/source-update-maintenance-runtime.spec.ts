import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceManager } from '../instance/instance-manager';
import { WorkAdmission } from '../work-admission/work-admission';
const state = vi.hoisted(() => ({ consults: 0, queue: false, landing: 0, queueRun: false, loops: false,
  campaigns: false, automations: false, repoJobs: false, browser: false, terminal: 0, remote: false, cdp: 0,
  worker: false, async: false, loan: false, runtime: false, continuation: false, queued: false, initialization: false,
  remoteReachable: true, entry: undefined as unknown, revive: vi.fn(), archive: vi.fn(),
}));
vi.mock('../work-admission/consult-admission', () => ({ getActiveConsultCount: () => state.consults }));
vi.mock('../plan-queue/plan-queue-bootstrap', () => ({ getPlanQueueStoreIfInitialized: () => ({
  hasActiveWork: () => state.queue, countAutomaticLandings: () => state.landing,
  listActiveRuns: () => state.queueRun ? [{ status: 'running' }] : [],
}) }));
vi.mock('../orchestration/loop-coordinator', () => ({ getLoopCoordinator: () => ({ getActiveLoops: () => state.loops ? [{ status: 'running' }] : [] }) }));
vi.mock('../orchestration/campaign-coordinator', () => ({ getCampaignCoordinator: () => ({ listRunningCampaigns: () => state.campaigns ? [{}] : [] }) }));
vi.mock('../automations', () => ({ getAutomationStore: () => ({ listActiveRuns: () => state.automations ? [{ status: 'pending' }] : [] }) }));
vi.mock('../repo-jobs/repo-job-service', () => ({ getRepoJobService: () => ({ getActiveJobs: () => state.repoJobs ? [{}] : [], getRunningJobsForGlobalPause: () => state.repoJobs ? [{}] : [] }) }));
vi.mock('../browser-gateway/browser-extension-command-store', () => ({ getBrowserExtensionCommandStore: () => ({
  listActiveQueueKeys: () => ['node:worker'], describeQueue: () => ({ queuedCount: 0, inFlightCount: state.browser ? 1 : 0 }),
}) }));
vi.mock('../remote-node/remote-cdp-tunnel', () => ({ getRemoteCdpTunnelClient: () => ({ activeSessionCount: () => state.cdp }) }));
vi.mock('../remote-node/remote-terminal-manager', () => ({ getRemoteTerminalManager: () => ({ activeSessionCount: () => state.terminal }) }));
vi.mock('../remote-node/worker-node-connection', () => ({ getWorkerNodeConnectionServer: () => ({ hasActiveWork: () => state.remote }) }));
vi.mock('../remote-node/worker-mode-runtime-service', () => ({ getWorkerModeRuntimeService: () => ({ status: () => ({ state: state.worker ? 'running' : 'stopped' }) }) }));
vi.mock('../instance/instance-continuation-runtime', () => ({ hasPendingInstanceContinuation: () => state.continuation }));
vi.mock('../instance/instance-async-work-registry', () => ({ getInstanceAsyncWorkRegistry: () => ({ hasInhibitor: () => state.async }) }));
vi.mock('../instance/lifecycle/adapter-loan-registry', () => ({ isAdapterOnLoan: () => state.loan, isRuntimeChangeInFlight: () => state.runtime }));
vi.mock('../instance/lifecycle/initial-prompt-recovery', () => ({ hasPendingInitialPrompt: () => state.initialization }));
vi.mock('../session/session-queue-service', () => ({ getSessionQueueService: () => ({ hasQueuedMessages: () => state.queued }) }));
vi.mock('../session/session-revival-service', () => ({ SessionRevivalService: class { revive = state.revive; } }));
vi.mock('../session/session-recovery-candidate-service', () => ({ waitForSessionRecoveryStartupArchive: async () => undefined }));
vi.mock('../ipc/handlers/remote-node-check', () => ({ isRemoteNodeReachable: () => state.remoteReachable }));
vi.mock('../history/history-manager', () => ({ getHistoryManager: () => ({ startupTasks: Promise.resolve(),
  archiveInstance: state.archive, getEntries: () => state.entry ? [state.entry] : [],
}) }));
import { createMaintenanceDependencies } from './source-update-maintenance-runtime';
const manager = { hasPendingSourceUpdateOperations: () => false, hasActiveSessionWork: () => false,
  getInstance: () => ({ id: 'one', executionLocation: { type: 'remote', nodeId: 'worker' } }),
} as unknown as InstanceManager;
beforeEach(() => {
  WorkAdmission._resetForTesting(); vi.clearAllMocks();
  Object.assign(state, { consults: 0, queue: false, landing: 0, queueRun: false, loops: false,
    campaigns: false, automations: false, repoJobs: false, browser: false, terminal: 0, remote: false, cdp: 0,
    worker: false, async: false, loan: false, runtime: false, continuation: false, queued: false, initialization: false,
    remoteReachable: true, entry: undefined });
});
describe('source update authoritative activity wiring', () => {
  it('allows an idle coordinator without active engines or queued work', () => {
    const deps = createMaintenanceDependencies(manager);
    expect(deps.hasActiveWork()).toBe(false); expect(deps.hasSessionWork('one')).toBe(false);
  });
  it.each(['queue', 'queueRun', 'loops', 'campaigns', 'automations', 'repoJobs', 'browser', 'remote', 'worker'] as const)('defers for authoritative %s work', key => {
    state[key] = true; expect(createMaintenanceDependencies(manager).hasActiveWork()).toBe(true);
  });
  it.each(['consults', 'landing', 'terminal', 'cdp'] as const)('defers for nonzero %s, including landings after their run ends', key => {
    state[key] = 1; expect(createMaintenanceDependencies(manager).hasActiveWork()).toBe(true);
  });
  it.each(['async', 'loan', 'runtime', 'continuation', 'queued', 'initialization'] as const)('defers for session %s work', key => {
    state[key] = true; expect(createMaintenanceDependencies(manager).hasSessionWork('one')).toBe(true);
  });
  it('does not mistake engine counter work for an idle chat', () => {
    const deps = createMaintenanceDependencies(manager); deps.admission.registerCounter('background-index', () => 1);
    expect(deps.hasActiveWork()).toBe(true);
  });
  it('refuses remote restoration rather than moving its conversation to this computer', async () => {
    state.remoteReachable = false; state.entry = { id: 'history', executionLocation: { type: 'remote', nodeId: 'worker' } };
    const deps = createMaintenanceDependencies(manager);
    expect(deps.hasSessionWork('one')).toBe(true);
    await expect(deps.revive({ historyEntryId: 'history', reviveIfArchived: true, reason: 'source-update' })).rejects.toThrow('not reconnected');
    expect(state.revive).not.toHaveBeenCalled();
  });
});
