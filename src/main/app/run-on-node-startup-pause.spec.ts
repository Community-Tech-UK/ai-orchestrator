import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOrchestratorToolsStep } from './orchestrator-tools-step';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';
import { pauseConsults } from '../work-admission/consult-admission';
import { EventEmitter } from 'node:events';
import { markAutomaticStartupInputDispatched } from '../work-admission/automatic-startup';

const state = vi.hoisted(() => ({ options: undefined as undefined | { spawnRemoteInstance(args: { node: string; prompt: string; provider: string }): Promise<unknown> } }));
vi.mock('../mcp/orchestrator-tools-rpc-server', () => ({ initializeOrchestratorToolsRpcServer: async (options: typeof state.options) => { state.options = options; } }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => 3, getAll: () => ({ maxSpawnDepth: 3, maxTotalInstances: 20, defaultCli: 'codex' }) }) }));
vi.mock('../operator/operator-database', () => ({ defaultOperatorDbPath: () => '/tmp/operator.db', getOperatorDatabase: () => ({ db: {} }) }));
vi.mock('../mcp/secret-storage', () => ({ getMcpSecretStorage: () => ({}) }));
vi.mock('../graph/graph-token-store', () => ({ GraphTokenStore: class {} }));
vi.mock('../graph/graph-auth', () => ({ GraphAuthManager: class {} }));
vi.mock('../graph/graph-client', () => ({ GraphClient: class {} }));
vi.mock('../remote-node', () => ({ getWorkerNodeRegistry: () => ({ getAllNodes: () => [{ id: 'windows', name: 'Windows', status: 'connected', capabilities: { supportedClis: ['codex'], workingDirectories: ['/work'] } }] }), getWorkerNodeConnectionServer: () => ({}), getRemoteNodeRosterService: () => ({}) }));
vi.mock('../remote-node/service-rpc-client', () => ({ sendServiceRpc: async () => ({ ok: true, provider: { provider: 'codex', available: true, authenticated: true } }) }));
vi.mock('../automations', () => ({ getAutomationRunner: vi.fn(), getAutomationScheduler: vi.fn(), getAutomationStore: vi.fn() }));
vi.mock('../automations/automation-events', () => ({ getAutomationEvents: vi.fn() }));
vi.mock('../automations/automation-tool-impl', () => ({ createAutomationToolImplementations: () => ({}) }));
vi.mock('../doc-review/doc-review-service', () => ({ getDocReviewService: () => ({ setDeliveryCoordinator: vi.fn(), recoverUndelivered: async () => undefined }) }));
vi.mock('../orchestration/loop-coordinator', () => ({ getLoopCoordinator: () => ({}) }));
vi.mock('../pause/pause-coordinator', () => ({ getPauseCoordinator: () => ({}) }));
vi.mock('../local-ai-guard/default-local-ai-public-operations', () => ({ createDefaultLocalAiPublicOperations: () => ({}) }));
vi.mock('../orchestration/default-loop-cli-operations', () => ({ createDefaultLoopCliOperations: () => ({}) }));
vi.mock('../mcp/copilot-account-cli-operations', () => ({ createDefaultCopilotAccountCliOperations: () => ({}) }));
vi.mock('../instance/cross-session-messaging', () => ({ getCrossSessionMessagingService: () => ({}) }));

afterEach(() => WorkAdmission._resetForTesting());
describe('run_on_node startup pause', () => {
  it('returns a working session after initial input dispatch without awaiting its entire first turn', async () => {
    let finishTurn!: () => void;
    const firstTurn = new Promise<void>(resolve => { finishTurn = resolve; });
    const events = new EventEmitter();
    const instance = { id: 'running-remote', status: 'initializing', readyPromise: firstTurn };
    const manager = Object.assign(events, { getAllInstances: () => [], getInstance: () => instance,
      terminateInstance: vi.fn(async () => undefined),
      createInstance: async () => {
        setImmediate(() => {
          markAutomaticStartupInputDispatched(instance.id);
          instance.status = 'busy';
          events.emit('instance:state-changed', { instanceId: instance.id, status: 'busy', instance });
        });
        return instance;
      } });
    await createOrchestratorToolsStep(manager as never, {} as never).fn();
    const originalListeners = events.listenerCount('instance:state-changed');
    let returned = false;
    const spawning = state.options!.spawnRemoteInstance({ node: 'windows', provider: 'codex', prompt: 'Implement the export guard' })
      .then(result => { returned = true; return result; });
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    const returnedBeforeTurnCompleted = returned;
    finishTurn();
    await expect(spawning).resolves.toMatchObject({ instanceId: instance.id, status: 'busy' });
    expect(returnedBeforeTurnCompleted).toBe(true);
    expect(events.listenerCount('instance:state-changed')).toBe(originalListeners);
  });
  it('waits for late remote creation and teardown instead of returning a live helper after pause', async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const creation = new Promise<void>(resolve => { release = resolve; });
    const terminateInstance = vi.fn(async () => undefined);
    const manager = { getAllInstances: () => [], getInstance: () => undefined, terminateInstance,
      createInstance: async () => { entered(); await creation; return { id: 'late-remote', status: 'busy' }; } };
    await createOrchestratorToolsStep(manager as never, {} as never).fn();
    const spawning = state.options!.spawnRemoteInstance({ node: 'windows', provider: 'codex', prompt: 'Implement the export guard' });
    const cancelled = expect(spawning).rejects.toThrow('cancelled for restart');
    await started; getWorkAdmission().setGlobalPhase('collecting');
    let stopped = false;
    const pausing = pauseConsults().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const stoppedBeforeCreation = stopped;
    release(); await cancelled; await pausing;
    expect(stoppedBeforeCreation).toBe(false);
    expect(terminateInstance).toHaveBeenCalledWith('late-remote', false);
  });
});
