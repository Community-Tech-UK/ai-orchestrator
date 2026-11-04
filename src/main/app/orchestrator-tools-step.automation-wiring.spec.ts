import { describe, expect, it, vi } from 'vitest';
import type { OrchestratorToolsRpcServerOptions } from '../mcp/orchestrator-tools-rpc-server';
import type { AutomationToolImplDeps } from '../automations/automation-tool-impl';
import type { Instance } from '../../shared/types/instance.types';

const captured = vi.hoisted(() => ({
  init: vi.fn(), implementations: vi.fn(), recordResult: vi.fn(() => ({ recorded: true })), markDelivery: vi.fn(),
}));
vi.mock('../mcp/orchestrator-tools-rpc-server', () => ({ initializeOrchestratorToolsRpcServer: captured.init }));
vi.mock('../automations/automation-tool-impl', () => ({ createAutomationToolImplementations: captured.implementations }));
vi.mock('../automations', () => ({
  getAutomationRunner: () => ({ recordResult: captured.recordResult, markDeliveryStartedForCaller: captured.markDelivery }),
  getAutomationScheduler: vi.fn(), getAutomationStore: vi.fn(),
}));
vi.mock('../automations/automation-create-service', () => ({ createAutomationWithScheduling: vi.fn(), handlePastOneTimeAutomation: vi.fn() }));
vi.mock('../automations/automation-events', () => ({ getAutomationEvents: vi.fn() }));
vi.mock('../doc-review/doc-review-service', () => ({ getDocReviewService: () => ({
  setDeliveryCoordinator: vi.fn(), recoverUndelivered: async () => undefined,
}) }));
vi.mock('../doc-review/doc-review-delivery-coordinator', () => ({ DocReviewDeliveryCoordinator: class {} }));
vi.mock('../orchestration/loop-coordinator', () => ({ getLoopCoordinator: vi.fn() }));
vi.mock('../pause/pause-coordinator', () => ({ getPauseCoordinator: vi.fn() }));
vi.mock('../remote-node/remote-node-file-transfer-mcp-service', () => ({ createRemoteNodeFileTransferImplementations: () => ({}) }));
vi.mock('../process/host-process-inspector', () => ({ createDefaultHostProcessRuntime: vi.fn(), listHostProcesses: vi.fn(), stopLeftoverProcesses: vi.fn() }));
vi.mock('../process/host-process-instance-hooks', () => ({ createInstanceManagerHostProcessHooks: vi.fn() }));
vi.mock('../local-ai-guard/default-local-ai-public-operations', () => ({ createDefaultLocalAiPublicOperations: vi.fn() }));
vi.mock('../orchestration/default-loop-cli-operations', () => ({ createDefaultLoopCliOperations: vi.fn() }));
vi.mock('../mcp/copilot-account-cli-operations', () => ({ createDefaultCopilotAccountCliOperations: vi.fn() }));
vi.mock('../instance/cross-session-messaging', () => ({ getCrossSessionMessagingService: vi.fn() }));
vi.mock('../operator/operator-database', () => ({ defaultOperatorDbPath: () => 'unused-test-db' }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: vi.fn() }) }));

import { createOrchestratorToolsStep } from './orchestrator-tools-step';

describe('app scheduled tool composition', () => {
  async function start() {
    vi.clearAllMocks(); captured.implementations.mockReturnValue({});
    const caller = { id: 'scheduled-caller', provider: 'claude', currentModel: 'sonnet', reasoningEffort: 'low', yoloMode: false } as Instance;
    const getInstance = vi.fn((id: string) => id === caller.id ? caller : undefined);
    await createOrchestratorToolsStep({ getInstance } as never, {} as never).fn();
    return {
      caller, getInstance,
      deps: captured.implementations.mock.calls[0][0] as AutomationToolImplDeps,
      options: captured.init.mock.calls[0][0] as OrchestratorToolsRpcServerOptions,
    };
  }

  it('resolves the actual instance for the automation caller authority ceiling', async () => {
    const { caller, getInstance, deps } = await start();
    expect(deps.resolveCaller?.('scheduled-caller')).toBe(caller);
    expect(getInstance).toHaveBeenCalledWith('scheduled-caller');
    expect(deps.resolveCaller?.('missing-caller')).toBeUndefined();
  });

  it('records semantic results through the runner using authenticated metadata', async () => {
    const { options } = await start();
    const result = { outcome: 'no_change', notify: false } as const;
    expect(await options.automationResult?.(result, { callerInstanceId: 'scheduled-caller' })).toEqual({ recorded: true });
    expect(captured.recordResult).toHaveBeenCalledExactlyOnceWith('scheduled-caller', result);
  });
  it('marks outbound mutation through the actual runner callback', async () => {
    const { options } = await start();
    options.beforeExternalMutation?.('scheduled-child');
    expect(captured.markDelivery).toHaveBeenCalledExactlyOnceWith('scheduled-child');
  });
});
