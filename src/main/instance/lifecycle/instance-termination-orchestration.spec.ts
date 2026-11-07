import { describe, expect, it, vi } from 'vitest';
import { createInstance } from '../../../shared/types/instance.types';
import { OrchestrationHandler } from '../../orchestration/orchestration-handler';
import { InstanceTerminationCoordinator, type InstanceTerminationDeps } from './instance-termination';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/aio-orphan-context-fixture' } }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../../session/session-admission-service', () => ({ getSessionAdmissionService: () => ({ registerRedeliveryHandler: vi.fn(),
  admitAutomatedWrite: () => ({ kind: 'admitted', admissionId: 'fixture-admission' }), markDelivered: vi.fn() }) }));
vi.mock('../auto-title-service', () => ({ getAutoTitleService: () => ({ clearInstance: vi.fn() }) }));
vi.mock('../instance-provider-limit-handler', () => ({ getInstanceProviderLimitHandler: () => ({ release: vi.fn() }) }));
vi.mock('../instance-auth-repair-handler', () => ({ getInstanceAuthRepairHandler: () => ({ forget: vi.fn() }) }));
vi.mock('../../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../../session/session-continuity', () => ({ getSessionContinuityManagerIfInitialized: () => undefined }));

describe('surviving helper orchestration after closing its parent', () => {
  it.each(['orphan-children', 'reparent-to-root'] as const)('restores parent capabilities under %s without dropping its helpers', async childPolicy => {
    const parent = createInstance({ workingDirectory: '/tmp', provider: 'claude' });
    const child = createInstance({ workingDirectory: '/tmp', provider: 'claude', parentId: parent.id });
    const grandchild = createInstance({ workingDirectory: '/tmp', provider: 'claude', parentId: child.id });
    parent.childrenIds = [child.id]; child.childrenIds = [grandchild.id];
    const instances = new Map([parent, child, grandchild].map(instance => [instance.id, instance]));
    const handler = new OrchestrationHandler();
    for (const instance of instances.values()) handler.registerInstance(instance.id, instance.workingDirectory, instance.parentId);
    handler.addChild(parent.id, child.id); handler.addChild(child.id, grandchild.id);
    const userAction = vi.fn(); handler.on('user-action-request', userAction);
    handler.on('inject-response', (_id, _message, confirm: (error?: Error) => void) => confirm());
    const command = ':::ORCHESTRATOR_COMMAND:::\n' + JSON.stringify({ action: 'request_user_action', requestType: 'confirm', title: 'Fixture confirmation', message: 'Continue?' }) + '\n:::END_COMMAND:::';
    handler.processOutput(child.id, command);
    expect(userAction).not.toHaveBeenCalled();
    const deps: InstanceTerminationDeps = {
      getAdapter: () => undefined, getInstance: id => instances.get(id), deleteAdapter: () => false,
      deleteInstance: id => instances.delete(id), forceReleaseSessionMutex: vi.fn(), removeActivityDetector: vi.fn(),
      clearRecoveryHistory: vi.fn(), transitionState: (instance, status) => { instance.status = status; },
      terminateChild: vi.fn(async () => undefined), unregisterSupervisor: vi.fn(),
      unregisterOrchestration: id => handler.unregisterInstance(id), clearFirstMessageTracking: vi.fn(), endRlmSession: vi.fn(),
      deleteOutputStorage: async () => undefined, archiveInstance: async () => undefined, importTranscript: vi.fn(), emitRemoved: vi.fn(),
    };
    await new InstanceTerminationCoordinator(deps).terminateInstance(parent.id, true, { childPolicy });
    expect(instances.has(parent.id)).toBe(false);
    expect(child.parentId).toBeNull();
    expect(child.childrenIds).toEqual([grandchild.id]);
    expect(deps.terminateChild).not.toHaveBeenCalled();

    handler.processOutput(child.id, command);
    expect(userAction).toHaveBeenCalledOnce();
    // Its own helper still has a live parent, so worker restrictions still apply.
    handler.processOutput(grandchild.id, command);
    expect(userAction).toHaveBeenCalledOnce();
  });
});
