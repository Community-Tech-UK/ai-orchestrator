import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import type { OperationalDecision } from '@contracts/schemas/workboard';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { ProviderLimitEvent } from '../../core/system/provider-limit-ledger';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse<OperationalDecision[]>>;
const handlers = new Map<string, IpcHandler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const fakeLoopStore = {
  getRunSummary: vi.fn(),
  getRunConfig: vi.fn(),
  listTerminalIntents: vi.fn(() => []),
};
vi.mock('../../orchestration/loop-store', () => ({ getLoopStore: () => fakeLoopStore }));

const fakeLedger = {
  list: vi.fn((): ProviderLimitEvent[] => []),
  getActive: vi.fn((): ProviderLimitEvent | null => null),
};
vi.mock('../../core/system/provider-limit-ledger', () => ({
  ProviderLimitLedger: { getInstance: () => fakeLedger },
}));

const fakeEpochTracker = { getHistory: vi.fn(() => []) };
const fakeCompactionCoordinator = { getEpochTracker: vi.fn(() => fakeEpochTracker) };
vi.mock('../../context/compaction-coordinator', () => ({
  getCompactionCoordinator: () => fakeCompactionCoordinator,
}));

const fakeAutomationStore = { getRun: vi.fn(() => null) };
vi.mock('../../automations', () => ({ getAutomationStore: () => fakeAutomationStore }));

const fakeAdmissionStore = { list: vi.fn(() => []) };
vi.mock('../../session/session-admission-store', () => ({
  SessionAdmissionStore: { getInstance: () => fakeAdmissionStore },
}));

vi.mock('../../persistence/rlm-database', () => ({
  getRLMDatabase: () => ({ getRawDb: () => ({}) }),
}));

async function invoke(payload?: unknown): Promise<IpcResponse<OperationalDecision[]>> {
  const handler = handlers.get(IPC_CHANNELS.WORKBOARD_DECISIONS_FOR_ITEM);
  if (!handler) throw new Error('WORKBOARD_DECISIONS_FOR_ITEM not registered');
  return handler({}, payload);
}

function fakeInstanceManager(provider?: string) {
  return {
    getInstance: vi.fn((id: string) => (provider ? { id, provider } : undefined)),
  } as unknown as import('../../instance/instance-manager').InstanceManager;
}

describe('registerWorkboardHandlers', () => {
  beforeEach(async () => {
    handlers.clear();
    vi.clearAllMocks();
    fakeLoopStore.getRunSummary.mockReset().mockReturnValue(null);
    fakeLoopStore.getRunConfig.mockReset().mockReturnValue(null);
    fakeLoopStore.listTerminalIntents.mockReset().mockReturnValue([]);
    fakeLedger.list.mockReset().mockReturnValue([]);
    fakeLedger.getActive.mockReset().mockReturnValue(null);
    fakeEpochTracker.getHistory.mockReset().mockReturnValue([]);
    fakeAutomationStore.getRun.mockReset().mockReturnValue(null);
    fakeAdmissionStore.list.mockReset().mockReturnValue([]);

    const { registerWorkboardHandlers } = await import('./workboard-handlers');
    registerWorkboardHandlers({ instanceManager: fakeInstanceManager() });
  });

  it('registers the decisions-for-item channel', () => {
    expect(handlers.has(IPC_CHANNELS.WORKBOARD_DECISIONS_FOR_ITEM)).toBe(true);
  });

  it('rejects a payload with none of the three correlating ids', async () => {
    const response = await invoke({});
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('WORKBOARD_DECISIONS_FOR_ITEM_FAILED');
  });

  it('returns an empty timeline when every source has nothing for the item', async () => {
    const response = await invoke({ instanceId: 'inst-1' });
    expect(response).toEqual({ success: true, data: [] });
  });

  it('assembles a provider-limit decision with a resume action for a resumable loop', async () => {
    fakeLoopStore.getRunSummary.mockReturnValue({
      id: 'loop-1', chatId: 'inst-1', status: 'provider-limit', endedAt: null,
      endReason: 'parked', startedAt: 1, totalIterations: 1, totalTokens: 0,
      totalCostCents: 0, workspaceCwd: '/ws', initialPrompt: 'x', iterationPrompt: null,
    });
    fakeLoopStore.getRunConfig.mockReturnValue({ provider: 'claude' });
    const event: ProviderLimitEvent = { id: 'evt-1', provider: 'claude', model: null, detectedAt: 10, resumeAt: 20, source: 'loop-quota', instanceId: 'loop-1' };
    fakeLedger.list.mockReturnValue([event]);
    fakeLedger.getActive.mockReturnValue(event);

    const response = await invoke({ loopRunId: 'loop-1' });
    expect(response.success).toBe(true);
    expect(response.data).toHaveLength(1);
    expect(response.data![0]).toMatchObject({
      source: 'provider-limit',
      title: 'Paused: Claude hit its usage limit',
      operatorAction: { kind: 'resume-loop', label: 'Resume now', loopRunId: 'loop-1' },
    });
    expect(fakeLedger.list).toHaveBeenCalledWith({ provider: 'claude' });
  });

  it('resolves the provider from the live instance over the loop config', async () => {
    handlers.clear();
    const { registerWorkboardHandlers } = await import('./workboard-handlers');
    registerWorkboardHandlers({ instanceManager: fakeInstanceManager('codex') });

    await invoke({ instanceId: 'inst-1' });
    expect(fakeLedger.list).toHaveBeenCalledWith({ provider: 'codex' });
  });

  it('skips the provider-limit source entirely when no provider can be resolved', async () => {
    await invoke({ instanceId: 'inst-1' });
    expect(fakeLedger.list).not.toHaveBeenCalled();
  });

  it('queries compaction and admission sources by instanceId', async () => {
    await invoke({ instanceId: 'inst-1' });
    expect(fakeCompactionCoordinator.getEpochTracker).toHaveBeenCalledWith('inst-1');
    expect(fakeAdmissionStore.list).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      states: ['suppressed', 'expired', 'cancelled', 'failed'],
      limit: 10,
    });
  });

  it('queries the automation store by automationRunId', async () => {
    await invoke({ automationRunId: 'run-1' });
    expect(fakeAutomationStore.getRun).toHaveBeenCalledWith('run-1');
  });

  it('never queries loop-scoped sources when loopRunId is absent', async () => {
    await invoke({ instanceId: 'inst-1' });
    expect(fakeLoopStore.listTerminalIntents).not.toHaveBeenCalled();
  });

  it('returns a validation-shaped error and does not throw when a store read fails', async () => {
    fakeLoopStore.getRunSummary.mockImplementation(() => {
      throw new Error('db is locked');
    });
    const response = await invoke({ loopRunId: 'loop-1' });
    expect(response).toMatchObject({
      success: false,
      error: { code: 'WORKBOARD_DECISIONS_FOR_ITEM_FAILED', message: 'db is locked' },
    });
  });
});
