import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadInstanceOutputFn } from '../mcp/orchestrator-tools';
import type { Instance } from '../../shared/types/instance.types';

const captured = vi.hoisted(() => ({ read: null as ReadInstanceOutputFn | null }));
vi.mock('../mcp/orchestrator-tools-rpc-server', () => ({ initializeOrchestratorToolsRpcServer: async (options: { readInstanceOutput: ReadInstanceOutputFn }) => { captured.read = options.readInstanceOutput; } }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => 0, getAll: () => ({ graphScopesJson: '[]', graphAgentWritableAccountsJson: '[]' }) }) }));
vi.mock('../operator/operator-database', () => ({ defaultOperatorDbPath: () => '/fixture', getOperatorDatabase: () => ({ db: {} }) }));
vi.mock('../graph/graph-token-store', () => ({ GraphTokenStore: class {} }));
vi.mock('../graph/graph-auth', () => ({ GraphAuthManager: class {} }));
vi.mock('../graph/graph-client', () => ({ GraphClient: class {} }));
vi.mock('../mcp/secret-storage', () => ({ getMcpSecretStorage: () => ({}) }));
vi.mock('../automations', () => ({ getAutomationRunner: vi.fn(), getAutomationScheduler: vi.fn(), getAutomationStore: vi.fn() }));
vi.mock('../automations/automation-events', () => ({ getAutomationEvents: vi.fn() }));
vi.mock('../automations/automation-tool-impl', () => ({ createAutomationToolImplementations: () => ({}) }));
vi.mock('../doc-review/doc-review-service', () => ({ getDocReviewService: () => ({ setDeliveryCoordinator: vi.fn(), recoverUndelivered: async () => {} }) }));
vi.mock('../doc-review/doc-review-delivery-coordinator', () => ({ DocReviewDeliveryCoordinator: class {} }));
vi.mock('../orchestration/loop-coordinator', () => ({ getLoopCoordinator: () => ({}) }));
vi.mock('../pause/pause-coordinator', () => ({ getPauseCoordinator: () => ({}) }));
vi.mock('../instance/cross-session-messaging', () => ({ getCrossSessionMessagingService: () => ({}) }));
vi.mock('../local-ai-guard/default-local-ai-public-operations', () => ({ createDefaultLocalAiPublicOperations: () => ({}) }));
vi.mock('../orchestration/default-loop-cli-operations', () => ({ createDefaultLoopCliOperations: () => ({}) }));
vi.mock('../mcp/copilot-account-cli-operations', () => ({ createDefaultCopilotAccountCliOperations: () => ({}) }));
import { createOrchestratorToolsStep } from './orchestrator-tools-step';

function instance(metadata?: Record<string, unknown>, status: Instance['status'] = 'idle'): Instance {
  return { id: 'fixture', metadata, status, outputBuffer: [{ id: 'm', type: 'assistant', content: 'private output', timestamp: 1 }] } as Instance;
}
async function setup(getInstance: () => Instance | undefined) {
  await createOrchestratorToolsStep({ getInstance } as never, {} as never).fn();
  return captured.read!;
}
beforeEach(() => { vi.clearAllMocks(); captured.read = null; });

describe('read_node_output ownership', () => {
  it('returns not found for an interactive session', async () => {
    const read = await setup(() => instance());
    expect(await read({ instanceId: 'fixture' })).toBeNull();
  });
  it('returns the buffer for a run_on_node session', async () => {
    const read = await setup(() => instance({ spawnDepth: 1 }));
    expect(await read({ instanceId: 'fixture' })).toMatchObject({ messages: [{ content: 'private output' }] });
  });
  it('rechecks ownership after polling', async () => {
    const lookup = vi.fn().mockReturnValueOnce(instance({ spawnDepth: 1 }, 'busy')).mockReturnValue(instance());
    const read = await setup(lookup);
    expect(await read({ instanceId: 'fixture', waitMs: 5 })).toBeNull();
  });
});
